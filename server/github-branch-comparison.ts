import type {
  GitHistoryCommit,
  GitHubBranchComparisonRequest,
  GitHubBranchComparisonResult,
  GitHubBranchComparisonState
} from '../src/shared/project-space-api';
import {
  getGitHubClientId,
  GitHubRequestError,
  requestGitHub,
  resolveToken
} from './local-github-catalog';

interface GitHubApiRepository {
  default_branch?: string;
}

interface GitHubApiBranch {
  commit?: {
    sha?: string;
  };
  name: string;
}

interface GitHubApiCommit {
  commit?: {
    author?: {
      date?: string | null;
      name?: string | null;
    } | null;
    committer?: {
      date?: string | null;
    } | null;
    message?: string | null;
  };
  parents?: Array<{ sha?: string }>;
  sha: string;
}

interface GitHubApiComparison {
  ahead_by: number;
  behind_by: number;
  merge_base_commit?: GitHubApiCommit;
}

type GitHubRequester = typeof requestGitHub;

const fullSha = /^[0-9a-f]{40}$/i;
const defaultComparisonLimit = 8;
const minimumComparisonLimit = 1;
const maximumComparisonLimit = 8;

export function isGitHubBranchComparisonRequest(
  value: unknown
): value is GitHubBranchComparisonRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<GitHubBranchComparisonRequest>;
  const validRepository =
    typeof request.fullName === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.fullName);
  const validBranch =
    typeof request.headBranch === 'string' &&
    request.headBranch.trim().length > 0 &&
    request.headBranch.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(request.headBranch);
  const validExpectedSha =
    request.expectedHeadSha === undefined ||
    (typeof request.expectedHeadSha === 'string' && fullSha.test(request.expectedHeadSha));
  const validLimit =
    request.limit === undefined ||
    (
      Number.isSafeInteger(request.limit) &&
      request.limit >= minimumComparisonLimit &&
      request.limit <= maximumComparisonLimit
    );

  return validRepository && validBranch && validExpectedSha && validLimit;
}

function normalizeLimit(limit?: number) {
  if (!Number.isFinite(limit)) {
    return defaultComparisonLimit;
  }

  return Math.max(
    minimumComparisonLimit,
    Math.min(maximumComparisonLimit, Math.floor(limit ?? defaultComparisonLimit))
  );
}

function repositoryPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function comparisonState(aheadBy: number, behindBy: number): GitHubBranchComparisonState {
  if (aheadBy > 0 && behindBy > 0) return 'diverged';
  if (aheadBy > 0) return 'ahead';
  if (behindBy > 0) return 'behind';
  return 'up-to-date';
}

function mapCommit(commit: GitHubApiCommit, refs: string[] = []): GitHistoryCommit {
  const date = commit.commit?.author?.date ?? commit.commit?.committer?.date ?? '';
  const message = commit.commit?.message ?? '';

  return {
    author: commit.commit?.author?.name ?? '',
    date: date.slice(0, 10),
    hash: commit.sha,
    parents:
      commit.parents
        ?.map((parent) => parent.sha)
        .filter((sha): sha is string => Boolean(sha)) ?? [],
    refs,
    subject: message.split('\n')[0] ?? ''
  };
}

function addTipRefs(
  commit: GitHistoryCommit,
  input: {
    defaultBranch: GitHubApiBranch;
    headBranch: GitHubApiBranch;
  }
) {
  const refs = [...commit.refs];

  if (commit.hash === input.defaultBranch.commit?.sha) {
    refs.push(
      input.defaultBranch.name,
      `origin/${input.defaultBranch.name}`,
      'origin/HEAD'
    );
  }
  if (commit.hash === input.headBranch.commit?.sha) {
    refs.push(`origin/${input.headBranch.name}`);
  }

  return { ...commit, refs: Array.from(new Set(refs)) };
}

function commitsThrough(
  commits: GitHistoryCommit[],
  hash: string
) {
  const index = commits.findIndex((commit) => commit.hash === hash);
  return index < 0 ? undefined : commits.slice(0, index + 1);
}

function uniqueByHash(commits: GitHistoryCommit[]) {
  const seen = new Set<string>();
  return commits.filter((commit) => {
    if (seen.has(commit.hash)) return false;
    seen.add(commit.hash);
    return true;
  });
}

function balancedTips(
  headCommits: GitHistoryCommit[],
  defaultCommits: GitHistoryCommit[],
  limit: number
) {
  const headLimit = Math.ceil(limit / 2);
  const defaultLimit = limit - headLimit;
  return uniqueByHash([
    ...headCommits.slice(0, headLimit),
    ...defaultCommits.slice(0, defaultLimit)
  ]).slice(0, limit);
}

function reaches(
  commits: GitHistoryCommit[],
  startSha: string | undefined,
  targetSha: string
) {
  if (!startSha) return false;
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const pending = [startSha];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const hash = pending.pop()!;
    if (hash === targetSha) return true;
    if (visited.has(hash)) continue;
    visited.add(hash);
    pending.push(...(commitsByHash.get(hash)?.parents ?? []));
  }

  return false;
}

function allocateUniqueBudget(
  headLength: number,
  defaultLength: number,
  budget: number
) {
  let head = headLength > 0 ? 1 : 0;
  let base = defaultLength > 0 ? 1 : 0;
  let remaining = Math.max(0, budget - head - base);

  while (remaining > 0) {
    const headRemaining = headLength - head;
    const baseRemaining = defaultLength - base;
    if (headRemaining <= 0 && baseRemaining <= 0) break;

    if (headRemaining >= baseRemaining && headRemaining > 0) {
      head += 1;
    } else if (baseRemaining > 0) {
      base += 1;
    }
    remaining -= 1;
  }

  return { defaultBudget: base, headBudget: head };
}

export function buildGitHubComparisonSlice(input: {
  defaultCommits: GitHistoryCommit[];
  headCommits: GitHistoryCommit[];
  limit?: number;
  mergeBaseSha?: string;
}) {
  const limit = normalizeLimit(input.limit);
  const mergeBaseSha = input.mergeBaseSha;

  if (!mergeBaseSha) {
    return {
      commits: balancedTips(input.headCommits, input.defaultCommits, limit),
      mergeBaseIncluded: false,
      truncated: true
    };
  }

  const headThroughBase = commitsThrough(input.headCommits, mergeBaseSha);
  const defaultThroughBase = commitsThrough(input.defaultCommits, mergeBaseSha);

  if (!headThroughBase || !defaultThroughBase) {
    return {
      commits: balancedTips(input.headCommits, input.defaultCommits, limit),
      mergeBaseIncluded: false,
      truncated: true
    };
  }

  const headUnique = headThroughBase.slice(0, -1);
  const defaultUnique = defaultThroughBase.slice(0, -1);
  const headBaseIndex = input.headCommits.findIndex((commit) => commit.hash === mergeBaseSha);
  const defaultBaseIndex = input.defaultCommits.findIndex((commit) => commit.hash === mergeBaseSha);
  const common = uniqueByHash([
    ...input.headCommits.slice(headBaseIndex),
    ...input.defaultCommits.slice(defaultBaseIndex)
  ]);
  const uniqueBudget = Math.max(0, limit - 1);
  const { defaultBudget, headBudget } = allocateUniqueBudget(
    headUnique.length,
    defaultUnique.length,
    uniqueBudget
  );
  const commits = uniqueByHash([
    ...headUnique.slice(0, headBudget),
    ...defaultUnique.slice(0, defaultBudget),
    ...common
  ]).slice(0, limit);
  const mergeBaseIncluded = commits.some((commit) => commit.hash === mergeBaseSha);
  const headTipSha = input.headCommits[0]?.hash;
  const defaultTipSha = input.defaultCommits[0]?.hash;
  const fullyConnected =
    reaches(commits, headTipSha, mergeBaseSha) &&
    reaches(commits, defaultTipSha, mergeBaseSha);

  return {
    commits,
    mergeBaseIncluded,
    truncated: !fullyConnected
  };
}

async function loadCommits(
  request: GitHubRequester,
  repoPath: string,
  sha: string,
  token: string,
  limit: number
) {
  const commits = await request<GitHubApiCommit[]>(
    `/repos/${repoPath}/commits?sha=${encodeURIComponent(sha)}&per_page=${limit}&page=1`,
    token
  );
  return commits.map((commit) => mapCommit(commit));
}

function unavailable(
  result: Pick<GitHubBranchComparisonResult, 'reason' | 'status'> & {
    message: string;
    now: Date;
  }
): GitHubBranchComparisonResult {
  return {
    checkedAt: result.now.toISOString(),
    commits: [],
    freshness: 'unavailable',
    mergeBaseIncluded: false,
    message: result.message,
    reason: result.reason,
    status: result.status,
    truncated: false
  };
}

function failureResult(error: unknown, now: Date, stage: 'repository' | 'head' | 'history') {
  if (error instanceof GitHubRequestError) {
    if (error.rateLimited) {
      return unavailable({
        message: 'GitHub rate limit reached. Branch position is temporarily unavailable.',
        now,
        reason: 'rate-limited',
        status: 'rate-limited'
      });
    }
    if (error.statusCode === 401 || error.statusCode === 403) {
      return unavailable({
        message: 'GitHub authorization is required to compare these branches.',
        now,
        reason: 'unauthorized',
        status: 'unauthorized'
      });
    }
    if (error.statusCode === 404) {
      return unavailable({
        message: stage === 'repository'
          ? 'The GitHub repository could not be found.'
          : stage === 'head'
            ? 'The linked branch no longer exists.'
            : 'GitHub could not resolve the branch history.',
        now,
        reason:
          stage === 'repository'
            ? 'repository-not-found'
            : stage === 'head'
              ? 'head-not-found'
              : 'history-unavailable',
        status: 'error'
      });
    }
  }

  return unavailable({
    message: 'Could not compare the linked branch.',
    now,
    reason: 'history-unavailable',
    status: 'error'
  });
}

export async function loadGitHubBranchComparison(
  input: GitHubBranchComparisonRequest,
  token: string,
  options: {
    now?: Date;
    request?: GitHubRequester;
  } = {}
): Promise<GitHubBranchComparisonResult> {
  const now = options.now ?? new Date();
  const request = options.request ?? requestGitHub;
  const repoPath = repositoryPath(input.fullName);
  let repository: GitHubApiRepository;

  try {
    repository = await request<GitHubApiRepository>(`/repos/${repoPath}`, token);
  } catch (error) {
    return failureResult(error, now, 'repository');
  }

  const defaultBranchName = repository.default_branch?.trim();
  const headBranchName = input.headBranch.trim();
  if (!defaultBranchName || !headBranchName) {
    return unavailable({
      message: 'GitHub did not provide both branch names for this comparison.',
      now,
      reason: 'history-unavailable',
      status: 'error'
    });
  }

  let defaultBranch: GitHubApiBranch;
  let headBranch: GitHubApiBranch;

  try {
    defaultBranch = await request<GitHubApiBranch>(
      `/repos/${repoPath}/branches/${encodeURIComponent(defaultBranchName)}`,
      token
    );
  } catch (error) {
    return failureResult(error, now, 'history');
  }
  try {
    headBranch = await request<GitHubApiBranch>(
      `/repos/${repoPath}/branches/${encodeURIComponent(headBranchName)}`,
      token
    );
  } catch (error) {
    return failureResult(error, now, 'head');
  }

  const defaultSha = defaultBranch.commit?.sha;
  const headSha = headBranch.commit?.sha;
  if (!defaultSha || !headSha || !fullSha.test(defaultSha) || !fullSha.test(headSha)) {
    return unavailable({
      message: 'GitHub did not return exact branch head commits.',
      now,
      reason: 'history-unavailable',
      status: 'error'
    });
  }

  if (
    input.expectedHeadSha &&
    (
      !fullSha.test(input.expectedHeadSha) ||
      input.expectedHeadSha.toLowerCase() !== headSha.toLowerCase()
    )
  ) {
    return {
      checkedAt: now.toISOString(),
      commits: [],
      defaultBranch: { name: defaultBranchName, sha: defaultSha },
      freshness: 'stale',
      head: { name: headBranchName, sha: headSha },
      mergeBaseIncluded: false,
      message: 'The linked pull request head changed. Refresh the issue before using this comparison.',
      reason: 'stale-head',
      status: 'connected',
      truncated: false
    };
  }

  let comparison: GitHubApiComparison;
  try {
    comparison = await request<GitHubApiComparison>(
      `/repos/${repoPath}/compare/${defaultSha}...${headSha}?per_page=1`,
      token
    );
  } catch (error) {
    return failureResult(error, now, 'history');
  }
  const mergeBaseSha = comparison.merge_base_commit?.sha;
  if (
    !Number.isSafeInteger(comparison.ahead_by) ||
    comparison.ahead_by < 0 ||
    !Number.isSafeInteger(comparison.behind_by) ||
    comparison.behind_by < 0 ||
    !mergeBaseSha ||
    !fullSha.test(mergeBaseSha)
  ) {
    return unavailable({
      message: 'GitHub returned an incomplete branch comparison.',
      now,
      reason: 'history-unavailable',
      status: 'error'
    });
  }

  const limit = normalizeLimit(input.limit);
  let defaultCommits: GitHistoryCommit[];
  let headCommits: GitHistoryCommit[];

  try {
    if (headSha === defaultSha) {
      headCommits = await loadCommits(request, repoPath, headSha, token, limit);
      defaultCommits = headCommits;
    } else {
      [headCommits, defaultCommits] = await Promise.all([
        loadCommits(request, repoPath, headSha, token, limit),
        loadCommits(request, repoPath, defaultSha, token, limit)
      ]);
    }
  } catch (error) {
    return failureResult(error, now, 'history');
  }
  if (
    headCommits[0]?.hash.toLowerCase() !== headSha.toLowerCase() ||
    defaultCommits[0]?.hash.toLowerCase() !== defaultSha.toLowerCase()
  ) {
    return unavailable({
      message: 'GitHub returned history for a different branch head.',
      now,
      reason: 'history-unavailable',
      status: 'error'
    });
  }

  const slice = buildGitHubComparisonSlice({
    defaultCommits,
    headCommits,
    limit,
    mergeBaseSha
  });
  const commits = slice.commits.map((commit) =>
    addTipRefs(commit, { defaultBranch, headBranch })
  );
  return {
    aheadBy: comparison.ahead_by,
    behindBy: comparison.behind_by,
    checkedAt: now.toISOString(),
    commits,
    defaultBranch: { name: defaultBranchName, sha: defaultSha },
    freshness: 'current',
    head: { name: headBranchName, sha: headSha },
    mergeBaseIncluded: slice.mergeBaseIncluded,
    mergeBaseSha,
    state: comparisonState(comparison.ahead_by, comparison.behind_by),
    status: 'connected',
    truncated: slice.truncated
  };
}

export async function getGitHubBranchComparison(
  input: GitHubBranchComparisonRequest
): Promise<GitHubBranchComparisonResult> {
  const auth = await resolveToken();
  const now = new Date();

  if (!auth) {
    const configured = Boolean(getGitHubClientId());
    return unavailable({
      message: configured
        ? 'Connect GitHub to compare the linked branch.'
        : 'GitHub OAuth is not configured.',
      now,
      reason: configured ? 'auth-required' : 'not-configured',
      status: configured ? 'auth-required' : 'not-configured'
    });
  }

  return loadGitHubBranchComparison(input, auth.token, { now });
}
