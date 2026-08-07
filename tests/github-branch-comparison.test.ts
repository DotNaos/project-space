import { describe, expect, test } from 'bun:test';
import {
  buildGitHubComparisonSlice,
  isGitHubBranchComparisonRequest,
  loadGitHubBranchComparison
} from '../server/github-branch-comparison';
import { GitHubRequestError } from '../server/local-github-catalog';
import type { requestGitHub } from '../server/local-github-catalog';
import type {
  GitHistoryCommit,
  GitHubBranchComparisonState
} from '../src/shared/project-space-api';

const baseSha = 'c'.repeat(40);
const defaultSha = 'b'.repeat(40);
const headSha = 'a'.repeat(40);

function apiCommit(sha: string, parents: string[] = []) {
  return {
    commit: {
      author: {
        date: '2026-07-30T10:00:00Z',
        name: 'Test Author'
      },
      message: `Commit ${sha.slice(0, 4)}`
    },
    parents: parents.map((parent) => ({ sha: parent })),
    sha
  };
}

function historyCommit(hash: string, parents: string[] = []): GitHistoryCommit {
  return {
    author: 'Test Author',
    date: '2026-07-30',
    hash,
    parents,
    refs: [],
    subject: `Commit ${hash.slice(0, 4)}`
  };
}

function comparisonRequester(input: {
  aheadBy: number;
  behindBy: number;
  defaultHead: string;
  defaultHistory: ReturnType<typeof apiCommit>[];
  head: string;
  headHistory: ReturnType<typeof apiCommit>[];
  mergeBase: string;
  paths: string[];
}) {
  return (async <Result>(path: string) => {
    input.paths.push(path);
    if (path === '/repos/DotNaos/project-space') {
      return { default_branch: 'trunk' } as Result;
    }
    if (path.endsWith('/branches/trunk')) {
      return { commit: { sha: input.defaultHead }, name: 'trunk' } as Result;
    }
    if (path.endsWith('/branches/feature%2Fissue-408')) {
      return { commit: { sha: input.head }, name: 'feature/issue-408' } as Result;
    }
    if (path.includes('/compare/')) {
      return {
        ahead_by: input.aheadBy,
        behind_by: input.behindBy,
        merge_base_commit: apiCommit(input.mergeBase)
      } as Result;
    }
    if (path.includes(`/commits?sha=${input.head}`)) {
      return input.headHistory as Result;
    }
    if (path.includes(`/commits?sha=${input.defaultHead}`)) {
      return input.defaultHistory as Result;
    }
    throw new Error(`Unexpected GitHub path: ${path}`);
  }) as typeof requestGitHub;
}

describe('GitHub branch comparison', () => {
  test('validates the bounded request contract', () => {
    expect(isGitHubBranchComparisonRequest({
      expectedHeadSha: headSha,
      fullName: 'DotNaos/project-space',
      headBranch: 'feature/issue-408',
      limit: 8
    })).toBe(true);
    expect(isGitHubBranchComparisonRequest({
      fullName: 'DotNaos/project-space',
      headBranch: 'issue-473-release-tag-queue-no-conflicts',
      limit: 1
    })).toBe(true);
    expect(isGitHubBranchComparisonRequest({
      fullName: 'DotNaos/project-space',
      headBranch: 'feature/issue-408',
      limit: 9
    })).toBe(false);
    expect(isGitHubBranchComparisonRequest({
      fullName: 'DotNaos/project-space',
      headBranch: 'feature/issue-408',
      limit: 0
    })).toBe(false);
    expect(isGitHubBranchComparisonRequest({
      fullName: 'not-a-repository',
      headBranch: 'feature'
    })).toBe(false);
  });

  test('honors the one-commit pre-PR comparison request', async () => {
    const paths: string[] = [];
    const result = await loadGitHubBranchComparison(
      {
        expectedHeadSha: headSha,
        fullName: 'DotNaos/project-space',
        headBranch: 'feature/issue-408',
        limit: 1
      },
      'token',
      {
        request: comparisonRequester({
          aheadBy: 1,
          behindBy: 0,
          defaultHead: baseSha,
          defaultHistory: [apiCommit(baseSha)],
          head: headSha,
          headHistory: [apiCommit(headSha, [baseSha])],
          mergeBase: baseSha,
          paths
        })
      }
    );

    expect(result).toMatchObject({
      aheadBy: 1,
      freshness: 'current',
      status: 'connected'
    });
    expect(result.commits).toHaveLength(1);
    expect(paths).toContain(`/repos/DotNaos/project-space/commits?sha=${headSha}&per_page=1&page=1`);
    expect(paths).toContain(`/repos/DotNaos/project-space/commits?sha=${baseSha}&per_page=1&page=1`);
  });

  test('reports all four divergence states from exact immutable SHAs', async () => {
    const cases: Array<{
      aheadBy: number;
      behindBy: number;
      defaultHead: string;
      defaultHistory: ReturnType<typeof apiCommit>[];
      expected: GitHubBranchComparisonState;
      head: string;
      headHistory: ReturnType<typeof apiCommit>[];
      mergeBase: string;
    }> = [
      {
        aheadBy: 0,
        behindBy: 0,
        defaultHead: headSha,
        defaultHistory: [apiCommit(headSha, [baseSha]), apiCommit(baseSha)],
        expected: 'up-to-date',
        head: headSha,
        headHistory: [apiCommit(headSha, [baseSha]), apiCommit(baseSha)],
        mergeBase: headSha
      },
      {
        aheadBy: 1,
        behindBy: 0,
        defaultHead: baseSha,
        defaultHistory: [apiCommit(baseSha)],
        expected: 'ahead',
        head: headSha,
        headHistory: [apiCommit(headSha, [baseSha]), apiCommit(baseSha)],
        mergeBase: baseSha
      },
      {
        aheadBy: 0,
        behindBy: 1,
        defaultHead: defaultSha,
        defaultHistory: [apiCommit(defaultSha, [baseSha]), apiCommit(baseSha)],
        expected: 'behind',
        head: baseSha,
        headHistory: [apiCommit(baseSha)],
        mergeBase: baseSha
      },
      {
        aheadBy: 1,
        behindBy: 1,
        defaultHead: defaultSha,
        defaultHistory: [apiCommit(defaultSha, [baseSha]), apiCommit(baseSha)],
        expected: 'diverged',
        head: headSha,
        headHistory: [apiCommit(headSha, [baseSha]), apiCommit(baseSha)],
        mergeBase: baseSha
      }
    ];

    for (const value of cases) {
      const paths: string[] = [];
      const result = await loadGitHubBranchComparison(
        {
          expectedHeadSha: value.head,
          fullName: 'DotNaos/project-space',
          headBranch: 'feature/issue-408',
          limit: 8
        },
        'token',
        {
          now: new Date('2026-07-30T10:00:00Z'),
          request: comparisonRequester({ ...value, paths })
        }
      );

      expect(result.state).toBe(value.expected);
      expect(result.aheadBy).toBe(value.aheadBy);
      expect(result.behindBy).toBe(value.behindBy);
      expect(result.defaultBranch).toEqual({ name: 'trunk', sha: value.defaultHead });
      expect(result.head).toEqual({ name: 'feature/issue-408', sha: value.head });
      expect(result.commits.length).toBeLessThanOrEqual(8);
      expect(paths).toContain(
        `/repos/DotNaos/project-space/compare/${value.defaultHead}...${value.head}?per_page=1`
      );
    }
  });

  test('keeps both tips and marks an omitted merge base as a collapsed gap', () => {
    const headCommits = Array.from({ length: 9 }, (_, index) =>
      historyCommit(`h${String(index).padStart(39, '0')}`)
    );
    const defaultCommits = Array.from({ length: 9 }, (_, index) =>
      historyCommit(`d${String(index).padStart(39, '0')}`)
    );

    const result = buildGitHubComparisonSlice({
      defaultCommits,
      headCommits,
      limit: 8,
      mergeBaseSha: baseSha
    });

    expect(result.commits).toHaveLength(8);
    expect(result.commits[0]?.hash).toBe(headCommits[0]?.hash);
    expect(result.commits.some((commit) => commit.hash === defaultCommits[0]?.hash)).toBe(true);
    expect(result.mergeBaseIncluded).toBe(false);
    expect(result.truncated).toBe(true);
  });

  test('marks an included merge base truncated when an intermediate parent is omitted', () => {
    const intermediateSha = 'd'.repeat(40);
    const result = buildGitHubComparisonSlice({
      defaultCommits: [
        historyCommit(defaultSha, [baseSha]),
        historyCommit(baseSha)
      ],
      headCommits: [
        historyCommit(headSha, [intermediateSha]),
        historyCommit(intermediateSha, [baseSha]),
        historyCommit(baseSha)
      ],
      limit: 3,
      mergeBaseSha: baseSha
    });

    expect(result.commits.map((commit) => commit.hash)).toEqual([
      headSha,
      defaultSha,
      baseSha
    ]);
    expect(result.mergeBaseIncluded).toBe(true);
    expect(result.truncated).toBe(true);
  });

  test('fills an up-to-date window with bounded common history', () => {
    const commits = Array.from({ length: 8 }, (_, index) => {
      const sha = String(index).padStart(40, '0');
      const parent = index < 7 ? String(index + 1).padStart(40, '0') : undefined;
      return historyCommit(sha, parent ? [parent] : []);
    });
    const result = buildGitHubComparisonSlice({
      defaultCommits: commits,
      headCommits: commits,
      limit: 8,
      mergeBaseSha: commits[0]!.hash
    });

    expect(result.commits).toHaveLength(8);
    expect(result.commits.map((commit) => commit.hash)).toEqual(
      commits.map((commit) => commit.hash)
    );
    expect(result.mergeBaseIncluded).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test('fails closed when the linked head is stale', async () => {
    const paths: string[] = [];
    const result = await loadGitHubBranchComparison(
      {
        expectedHeadSha: 'd'.repeat(40),
        fullName: 'DotNaos/project-space',
        headBranch: 'feature/issue-408'
      },
      'token',
      {
        now: new Date('2026-07-30T10:00:00Z'),
        request: comparisonRequester({
          aheadBy: 1,
          behindBy: 0,
          defaultHead: baseSha,
          defaultHistory: [apiCommit(baseSha)],
          head: headSha,
          headHistory: [apiCommit(headSha, [baseSha]), apiCommit(baseSha)],
          mergeBase: baseSha,
          paths
        })
      }
    );

    expect(result).toMatchObject({
      freshness: 'stale',
      reason: 'stale-head',
      status: 'connected'
    });
    expect(result.state).toBeUndefined();
    expect(result.aheadBy).toBeUndefined();
    expect(paths.some((path) => path.includes('/compare/'))).toBe(false);
  });

  test('rejects history that does not begin at the verified tips', async () => {
    const result = await loadGitHubBranchComparison(
      {
        expectedHeadSha: headSha,
        fullName: 'DotNaos/project-space',
        headBranch: 'feature/issue-408'
      },
      'token',
      {
        request: comparisonRequester({
          aheadBy: 1,
          behindBy: 0,
          defaultHead: baseSha,
          defaultHistory: [apiCommit(baseSha)],
          head: headSha,
          headHistory: [apiCommit('e'.repeat(40))],
          mergeBase: baseSha,
          paths: []
        })
      }
    );

    expect(result).toMatchObject({
      freshness: 'unavailable',
      reason: 'history-unavailable',
      status: 'error'
    });
    expect(result.state).toBeUndefined();
  });

  test('distinguishes deleted heads and rate limits', async () => {
    const deleted = await loadGitHubBranchComparison(
      {
        fullName: 'DotNaos/project-space',
        headBranch: 'deleted'
      },
      'token',
      {
        request: (async <Result>(path: string) => {
          if (path.endsWith('/branches/deleted')) {
            throw new GitHubRequestError(404, false);
          }
          if (path.endsWith('/branches/trunk')) {
            return { commit: { sha: defaultSha }, name: 'trunk' } as Result;
          }
          return { default_branch: 'trunk' } as Result;
        }) as typeof requestGitHub
      }
    );
    expect(deleted).toMatchObject({
      freshness: 'unavailable',
      reason: 'head-not-found',
      status: 'error'
    });

    const rateLimited = await loadGitHubBranchComparison(
      {
        fullName: 'DotNaos/project-space',
        headBranch: 'feature'
      },
      'token',
      {
        request: (async () => {
          throw new GitHubRequestError(403, true);
        }) as typeof requestGitHub
      }
    );
    expect(rateLimited).toMatchObject({
      freshness: 'unavailable',
      reason: 'rate-limited',
      status: 'rate-limited'
    });
  });

  test('reports authorization, missing repository, and incomplete comparison failures', async () => {
    const request = {
      fullName: 'DotNaos/project-space',
      headBranch: 'feature'
    };
    const unauthorized = await loadGitHubBranchComparison(
      request,
      'token',
      {
        request: (async () => {
          throw new GitHubRequestError(401, false);
        }) as typeof requestGitHub
      }
    );
    expect(unauthorized).toMatchObject({
      freshness: 'unavailable',
      reason: 'unauthorized',
      status: 'unauthorized'
    });

    const missingRepository = await loadGitHubBranchComparison(
      request,
      'token',
      {
        request: (async () => {
          throw new GitHubRequestError(404, false);
        }) as typeof requestGitHub
      }
    );
    expect(missingRepository).toMatchObject({
      freshness: 'unavailable',
      reason: 'repository-not-found',
      status: 'error'
    });

    const incomplete = await loadGitHubBranchComparison(
      request,
      'token',
      {
        request: (async <Result>(path: string) => {
          if (path === '/repos/DotNaos/project-space') {
            return { default_branch: 'trunk' } as Result;
          }
          if (path.endsWith('/branches/trunk')) {
            return { commit: { sha: defaultSha }, name: 'trunk' } as Result;
          }
          if (path.endsWith('/branches/feature')) {
            return { commit: { sha: headSha }, name: 'feature' } as Result;
          }
          return {
            ahead_by: 1,
            behind_by: 0
          } as Result;
        }) as typeof requestGitHub
      }
    );
    expect(incomplete).toMatchObject({
      freshness: 'unavailable',
      reason: 'history-unavailable',
      status: 'error'
    });
  });
});
