import { refreshProjectSpaceAuthToken } from './project-space-client-auth';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackUrl(url: URL) {
  return (
    ['http:', 'https:'].includes(url.protocol) && loopbackHosts.has(url.hostname.toLowerCase())
  );
}

function isPlainLoopbackOrigin(url: URL) {
  return (
    isLoopbackUrl(url) &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  );
}

export function resolveProjectSpaceApiBaseUrl(currentHref: string, explicit?: string | null) {
  try {
    const current = new URL(currentHref);
    if (!isLoopbackUrl(current)) return '';

    for (const value of [current.searchParams.get('projectSpaceApi'), explicit]) {
      if (!value) continue;
      try {
        const candidate = new URL(value);
        if (isPlainLoopbackOrigin(candidate)) {
          return candidate.origin === current.origin ? '' : candidate.origin;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return '';
  }
  return '';
}

export function isProjectSpaceApiRequestAllowed(currentHref: string, requestHref: string) {
  try {
    const current = new URL(currentHref);
    const request = new URL(requestHref, current);
    return (
      ['http:', 'https:'].includes(request.protocol) &&
      !request.username &&
      !request.password &&
      (request.origin === current.origin || (isLoopbackUrl(current) && isLoopbackUrl(request)))
    );
  } catch {
    return false;
  }
}

export function resolveApiBaseUrl() {
  return typeof window === 'undefined'
    ? ''
    : resolveProjectSpaceApiBaseUrl(
        window.location.href,
        import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL
      );
}

export function resolveApiRequestUrl(baseUrl: string, path: string) {
  if (typeof window === 'undefined') throw new Error('API requests require a browser window.');
  const requestUrl = new URL(`${baseUrl}${path}`, window.location.href);
  if (!isProjectSpaceApiRequestAllowed(window.location.href, requestUrl.toString())) {
    throw new Error('Project Space refused an API request to an untrusted origin.');
  }
  return requestUrl.toString();
}

function shouldUseCentralPreviewHub() {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'pr.projects.os-home.net' ||
    /^pr-[1-9][0-9]{0,8}\.projects\.os-home\.net$/i.test(window.location.hostname);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => undefined)) as
    { error?: string | { message?: unknown } } | T | undefined;

  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? payload.error
      : undefined;
    const message = typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : `Request failed with ${response.status}.`;

    throw new Error(message);
  }

  return payload as T;
}

export class ProjectSpaceHttpClient {
  private readonly baseUrl = resolveApiBaseUrl();

  protected async request<T>(path: string, init?: RequestInit): Promise<T> {
    const requestUrl = resolveApiRequestUrl(this.baseUrl, path);
    const token = await refreshProjectSpaceAuthToken();

    return fetch(requestUrl, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      },
      redirect: 'error'
    }).then((response) => readJsonResponse<T>(response));
  }

  protected async requestPreviewHub<T>(path: string, init?: RequestInit): Promise<T> {
    const requestUrl = shouldUseCentralPreviewHub()
      ? new URL(path, 'https://pr.projects.os-home.net').toString()
      : resolveApiRequestUrl(this.baseUrl, path);
    const token = await refreshProjectSpaceAuthToken();
    return fetch(requestUrl, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers
      },
      redirect: 'error'
    }).then((response) => readJsonResponse<T>(response));
  }

  protected async establishPreviewAccess(pullRequestNumber: number) {
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
      throw new Error('Preview pull request number is invalid.');
    }
    const token = await refreshProjectSpaceAuthToken();
    const previewOrigin = typeof window !== 'undefined' && window.location.hostname.endsWith('.localhost')
      ? window.location.origin
      : `https://pr-${pullRequestNumber}.projects.os-home.net`;
    const response = await fetch(`${previewOrigin}/api/pull-request-preview-access`, {
      credentials: 'include',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Origin: 'https://pr.projects.os-home.net'
      },
      method: 'POST',
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Preview access was not granted (${response.status}).`);
  }
}
