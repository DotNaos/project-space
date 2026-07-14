import type { GitHubRepositorySummaryResult } from '../shared/github-repository-summary';
import {
  isProjectSpaceApiRequestAllowed,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from './project-space-client';

export interface LoadGitHubRepositorySummaryOptions {
  apiBaseUrl?: string;
  currentHref?: string;
  fetchImplementation?: typeof fetch;
  getAuthToken?: () => Promise<string | null> | string | null;
  signal?: AbortSignal;
}

function isCount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRepositorySummaryResult(value: unknown): value is GitHubRepositorySummaryResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.fullName !== 'string'
    || typeof candidate.checkedAt !== 'string'
    || typeof candidate.status !== 'string'
    || !['auth-required', 'connected', 'error', 'not-configured'].includes(candidate.status)
  ) {
    return false;
  }

  if (candidate.status === 'connected') {
    return isCount(candidate.branchCount) && isCount(candidate.openIssueCount);
  }

  return typeof candidate.message === 'string' && candidate.message.length > 0;
}

export async function loadGitHubRepositorySummary(
  fullName: string,
  options: LoadGitHubRepositorySummaryOptions = {}
): Promise<GitHubRepositorySummaryResult> {
  const currentHref = options.currentHref
    ?? (typeof window === 'undefined' ? '' : window.location.href);
  if (!currentHref) throw new Error('Repository summary requests require a browser URL.');

  const explicitBaseUrl = options.apiBaseUrl ?? import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL;
  const baseUrl = resolveProjectSpaceApiBaseUrl(currentHref, explicitBaseUrl);
  const query = new URLSearchParams({ fullName });
  const requestUrl = new URL(`${baseUrl}/api/github/repository-summary?${query}`, currentHref);
  if (!isProjectSpaceApiRequestAllowed(currentHref, requestUrl.toString())) {
    throw new Error('Project Space refused a repository summary request to an untrusted origin.');
  }

  const token = options.getAuthToken
    ? await options.getAuthToken()
    : await refreshProjectSpaceAuthToken();
  const response = await (options.fetchImplementation ?? globalThis.fetch)(requestUrl, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    redirect: 'error',
    signal: options.signal
  });
  const payload = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: unknown }).error
      : undefined;
    throw new Error(
      typeof error === 'string' && error ? error : `Request failed with ${response.status}.`
    );
  }
  if (!isRepositorySummaryResult(payload)) {
    throw new Error('Project Space returned invalid repository counts.');
  }
  if (payload.fullName !== fullName) {
    throw new Error('Project Space returned counts for a different repository.');
  }

  return payload;
}
