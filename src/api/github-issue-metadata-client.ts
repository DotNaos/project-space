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

const metadataStatuses = new Set<GitHubIssueMetadataStatus>([
  'connected',
  'auth-required',
  'not-configured',
  'error'
]);

function isIssueLabel(value: unknown): value is GitHubIssueLabel {
  if (!value || typeof value !== 'object') return false;

  const label = value as Partial<GitHubIssueLabel>;

  return (
    typeof label.name === 'string' &&
    label.name.length > 0 &&
    label.name.length <= 50 &&
    typeof label.color === 'string' &&
    /^[0-9a-f]{6}$/i.test(label.color) &&
    (label.description === undefined || typeof label.description === 'string')
  );
}

function isIssueMetadataResult(value: unknown): value is GitHubIssueMetadataResult {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<GitHubIssueMetadataResult>;

  return (
    typeof candidate.fullName === 'string' &&
    Array.isArray(candidate.labels) &&
    candidate.labels.every(isIssueLabel) &&
    metadataStatuses.has(candidate.status as GitHubIssueMetadataStatus) &&
    (candidate.message === undefined || typeof candidate.message === 'string')
  );
}

export async function loadGitHubIssueMetadata(
  fullName: string,
  options: LoadGitHubIssueMetadataOptions = {}
): Promise<GitHubIssueMetadataResult> {
  const currentHref =
    options.currentHref ?? (typeof window === 'undefined' ? '' : window.location.href);
  if (!currentHref) {
    throw new Error('GitHub issue metadata requests require a browser URL.');
  }

  const explicitBaseUrl =
    options.apiBaseUrl ?? import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL;
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
  const payload = (await response.json().catch(() => undefined)) as unknown;

  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error?: unknown }).error
        : undefined;
    throw new Error(
      typeof error === 'string' && error ? error : `Request failed with ${response.status}.`
    );
  }

  if (!isIssueMetadataResult(payload)) {
    throw new Error('Project Space returned invalid GitHub issue metadata.');
  }

  if (payload.fullName !== fullName) {
    throw new Error('Project Space returned GitHub issue metadata for a different repository.');
  }

  return payload;
}
