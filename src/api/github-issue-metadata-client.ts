import {
  isProjectSpaceApiRequestAllowed,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from './project-space-client';

export interface GitHubIssueLabel {
  color: string;
  description?: string;
  name: string;
}

export type GitHubIssueMetadataStatus =
  | 'connected'
  | 'auth-required'
  | 'not-configured'
  | 'error';

export interface GitHubIssueMetadataResult {
  fullName: string;
  labels: GitHubIssueLabel[];
  message?: string;
  status: GitHubIssueMetadataStatus;
}

export interface LoadGitHubIssueMetadataOptions {
  apiBaseUrl?: string;
  currentHref?: string;
  fetchImplementation?: typeof fetch;
  getAuthToken?: () => Promise<string | null> | string | null;
  signal?: AbortSignal;
}

function isIssueMetadataResult(value: unknown): value is GitHubIssueMetadataResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GitHubIssueMetadataResult>;
  return (
    typeof candidate.fullName === 'string' &&
    Array.isArray(candidate.labels) &&
    ['connected', 'auth-required', 'not-configured', 'error'].includes(candidate.status ?? '')
  );
}

export async function loadGitHubIssueMetadata(
  fullName: string,
  options: LoadGitHubIssueMetadataOptions = {}
): Promise<GitHubIssueMetadataResult> {
  const currentHref = options.currentHref ??
    (typeof window === 'undefined' ? '' : window.location.href);
  if (!currentHref) throw new Error('GitHub issue metadata requests require a browser URL.');

  const explicitBaseUrl = options.apiBaseUrl ?? import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL;
  const baseUrl = resolveProjectSpaceApiBaseUrl(currentHref, explicitBaseUrl);
  const query = new URLSearchParams({ fullName });
  const requestUrl = new URL(`${baseUrl}/api/github/issue-metadata?${query}`, currentHref);
  if (!isProjectSpaceApiRequestAllowed(currentHref, requestUrl.toString())) {
    throw new Error('Project Space refused an issue metadata request to an untrusted origin.');
  }

  const token = options.getAuthToken
    ? await options.getAuthToken()
    : await refreshProjectSpaceAuthToken();
  const response = await (options.fetchImplementation ?? globalThis.fetch)(requestUrl, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    redirect: 'error',
    signal: options.signal
  });
  const payload = (await response.json().catch(() => undefined)) as
    | GitHubIssueMetadataResult
    | { error?: string }
    | undefined;

  if (!response.ok) {
    const message = payload && 'error' in payload && payload.error
      ? payload.error
      : `Request failed with ${response.status}.`;
    throw new Error(message);
  }
  if (!isIssueMetadataResult(payload)) {
    throw new Error('Project Space returned invalid GitHub issue metadata.');
  }
  if (payload.fullName !== fullName) {
    throw new Error('Project Space returned GitHub issue metadata for a different repository.');
  }

  return payload;
}
