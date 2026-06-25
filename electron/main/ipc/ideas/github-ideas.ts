import type {
  CreateGithubIdeaFromDraftRequest,
  GitHubAuthSession,
  GithubIdeaMutationResult,
  GithubIdeaRecord,
  ListGithubIdeasRequest,
  ProjectIssueSourceConfig,
  UpdateGithubIdeaRequest
} from '../../../../src/shared/electron-api';
import { requireGitHubAuthSession } from '../github-auth';
import { loadProjectIssueSourceConfig } from './project-issue-source-config';

const metadataMarker = '<!-- project-space-idea-meta';
const iterationLabelPrefix = 'iteration:';

interface GitHubLabelJson {
  name?: string;
}

interface GitHubIssueJson {
  body?: string | null;
  created_at: string;
  html_url: string;
  labels: GitHubLabelJson[];
  number: number;
  pull_request?: {
    url: string;
  };
  state: 'open' | 'closed';
  title: string;
  updated_at: string;
}

interface IdeaMetadata {
  evolvesIdeaId?: string;
  id: string;
}

interface GitHubIdeasDependencies {
  fetchImpl?: typeof fetch;
  loadAuthSession?: () => Promise<GitHubAuthSession>;
  loadProjectIssueSourceConfig?: (
    projectPath: string
  ) => Promise<ProjectIssueSourceConfig>;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return fallback;
}

function buildIterationLabel(iteration: string) {
  const normalizedIteration = iteration.trim();

  return normalizedIteration ? `${iterationLabelPrefix}${normalizedIteration}` : '';
}

function buildIssueBody({
  body,
  evolvesIdeaId,
  id
}: {
  body: string;
  evolvesIdeaId?: string;
  id: string;
}) {
  const metadata = JSON.stringify({
    evolvesIdeaId: evolvesIdeaId ?? null,
    id
  });
  const visibleBody = body.trim();
  const metadataBlock = `${metadataMarker}\n${metadata}\n-->`;

  return visibleBody ? `${visibleBody}\n\n${metadataBlock}` : metadataBlock;
}

function extractIdeaMetadata(body: string) {
  const match = body.match(/(?:\n{0,2})<!-- project-space-idea-meta\n([\s\S]*?)\n-->\s*$/);

  if (!match) {
    return {
      metadata: {
        id: ''
      } satisfies IdeaMetadata,
      visibleBody: body.trim()
    };
  }

  const [, metadataJson] = match;
  let parsedMetadata: Partial<IdeaMetadata> = {};

  try {
    parsedMetadata = JSON.parse(metadataJson) as Partial<IdeaMetadata>;
  } catch {
    parsedMetadata = {};
  }

  return {
    metadata: {
      evolvesIdeaId:
        typeof parsedMetadata.evolvesIdeaId === 'string' && parsedMetadata.evolvesIdeaId.trim()
          ? parsedMetadata.evolvesIdeaId
          : undefined,
      id: typeof parsedMetadata.id === 'string' ? parsedMetadata.id : ''
    },
    visibleBody: body.slice(0, match.index).trim()
  };
}

function mapGithubIssue(issue: GitHubIssueJson): GithubIdeaRecord {
  const labelNames = issue.labels
    .map((label) => label.name?.trim() || '')
    .filter(Boolean);
  const iterationLabel = labelNames.find((label) => label.startsWith(iterationLabelPrefix)) ?? '';
  const { metadata, visibleBody } = extractIdeaMetadata(issue.body?.trim() ?? '');

  return {
    body: visibleBody,
    createdAt: issue.created_at,
    evolvesIdeaId: metadata.evolvesIdeaId,
    githubIssueNumber: issue.number,
    githubIssueUrl: issue.html_url,
    githubLabels: labelNames,
    githubState: issue.state === 'closed' ? 'closed' : 'open',
    id: metadata.id || `github:${issue.number}`,
    iteration: iterationLabel.slice(iterationLabelPrefix.length),
    source: 'github',
    title: issue.title,
    updatedAt: issue.updated_at
  };
}

function getGithubRepoRef(url: string) {
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/i);

  return match?.[1] ?? '';
}

async function resolveGithubRepoRef(
  projectPath: string,
  deps: Required<Pick<GitHubIdeasDependencies, 'loadProjectIssueSourceConfig'>>
) {
  const config = await deps.loadProjectIssueSourceConfig(projectPath);

  if (config.kind !== 'github' || !config.url) {
    return '';
  }

  const repoRef = getGithubRepoRef(config.url);

  if (!repoRef) {
    throw new Error('The configured GitHub repository URL is invalid.');
  }

  return repoRef;
}

function buildHeaders(accessToken: string) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  };
}

async function fetchGitHubJson<T>(
  path: string,
  accessToken: string,
  deps: Required<Pick<GitHubIdeasDependencies, 'fetchImpl'>>,
  init: RequestInit = {}
) {
  const response = await deps.fetchImpl(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...buildHeaders(accessToken),
      ...(init.headers ?? {})
    }
  });

  if (!response.ok) {
    let message = 'GitHub request failed.';

    try {
      const payload = (await response.json()) as { message?: string };
      message = payload.message ?? message;
    } catch {
      // Ignore JSON parsing failures.
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function ensureIterationLabel(
  repoRef: string,
  iteration: string,
  accessToken: string,
  deps: Required<Pick<GitHubIdeasDependencies, 'fetchImpl'>>
) {
  const labelName = buildIterationLabel(iteration);

  if (!labelName) {
    return '';
  }

  const response = await deps.fetchImpl(`https://api.github.com/repos/${repoRef}/labels`, {
    body: JSON.stringify({
      color: '4F46E5',
      description: 'Iteration planning label managed by Project Space',
      name: labelName
    }),
    headers: buildHeaders(accessToken),
    method: 'POST'
  });

  if (!response.ok && response.status !== 422) {
    const payload = (await response.json().catch(() => ({ message: '' }))) as { message?: string };
    throw new Error(payload.message ?? 'Could not create the iteration label.');
  }

  return labelName;
}

function withDefaults(deps: GitHubIdeasDependencies = {}) {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    loadAuthSession:
      deps.loadAuthSession ??
      (() => Promise.resolve(requireGitHubAuthSession())),
    loadProjectIssueSourceConfig:
      deps.loadProjectIssueSourceConfig ?? loadProjectIssueSourceConfig
  };
}

export async function listGithubIdeas(
  { includeClosed, projectPath }: ListGithubIdeasRequest,
  deps: GitHubIdeasDependencies = {}
): Promise<GithubIdeaRecord[]> {
  try {
    const resolvedDeps = withDefaults(deps);
    const repoRef = await resolveGithubRepoRef(projectPath, resolvedDeps);

    if (!repoRef) {
      return [];
    }

    const session = await resolvedDeps.loadAuthSession();
    const issues = await fetchGitHubJson<GitHubIssueJson[]>(
      `/repos/${repoRef}/issues?state=${includeClosed ? 'all' : 'open'}&per_page=200`,
      session.accessToken,
      resolvedDeps
    );

    return issues
      .filter((issue) => !issue.pull_request)
      .map(mapGithubIssue)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    throw new Error(getErrorMessage(error, 'Could not load GitHub issues.'));
  }
}

export async function createGithubIdeaFromDraft(
  { draft, projectPath }: CreateGithubIdeaFromDraftRequest,
  deps: GitHubIdeasDependencies = {}
): Promise<GithubIdeaMutationResult> {
  if (!draft.title.trim()) {
    return {
      message: 'Add a title before publishing an idea to GitHub.',
      status: 'error'
    };
  }

  try {
    const resolvedDeps = withDefaults(deps);
    const repoRef = await resolveGithubRepoRef(projectPath, resolvedDeps);

    if (!repoRef) {
      throw new Error('This project is not configured to use GitHub issues.');
    }

    const session = await resolvedDeps.loadAuthSession();
    const iterationLabel = await ensureIterationLabel(
      repoRef,
      draft.iteration,
      session.accessToken,
      resolvedDeps
    );
    const createdIssue = await fetchGitHubJson<GitHubIssueJson>(
      `/repos/${repoRef}/issues`,
      session.accessToken,
      resolvedDeps,
      {
        body: JSON.stringify({
          body: buildIssueBody(draft),
          labels: iterationLabel ? [iterationLabel] : [],
          title: draft.title.trim()
        }),
        method: 'POST'
      }
    );

    return {
      idea: mapGithubIssue(createdIssue),
      status: 'success'
    };
  } catch (error) {
    return {
      message: getErrorMessage(error, 'Could not create the GitHub issue.'),
      status: 'error'
    };
  }
}

export async function updateGithubIdea(
  { idea, projectPath }: UpdateGithubIdeaRequest,
  deps: GitHubIdeasDependencies = {}
): Promise<GithubIdeaMutationResult> {
  if (!idea.title.trim()) {
    return {
      message: 'GitHub issues need a title.',
      status: 'error'
    };
  }

  try {
    const resolvedDeps = withDefaults(deps);
    const repoRef = await resolveGithubRepoRef(projectPath, resolvedDeps);

    if (!repoRef) {
      throw new Error('This project is not configured to use GitHub issues.');
    }

    const session = await resolvedDeps.loadAuthSession();
    const iterationLabel = await ensureIterationLabel(
      repoRef,
      idea.iteration,
      session.accessToken,
      resolvedDeps
    );
    const labels = [
      ...idea.githubLabels.filter((label) => !label.startsWith(iterationLabelPrefix)),
      ...(iterationLabel ? [iterationLabel] : [])
    ];
    const updatedIssue = await fetchGitHubJson<GitHubIssueJson>(
      `/repos/${repoRef}/issues/${idea.githubIssueNumber}`,
      session.accessToken,
      resolvedDeps,
      {
        body: JSON.stringify({
          body: buildIssueBody(idea),
          labels,
          state: idea.githubState,
          title: idea.title.trim()
        }),
        method: 'PATCH'
      }
    );

    return {
      idea: mapGithubIssue(updatedIssue),
      status: 'success'
    };
  } catch (error) {
    return {
      message: getErrorMessage(error, 'Could not update the GitHub issue.'),
      status: 'error'
    };
  }
}
