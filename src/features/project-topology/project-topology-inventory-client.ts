import {
  isProjectSpaceApiRequestAllowed,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from '@/api/project-space-client';
import {
  parseProjectTopologyWorktreeSnapshot,
  type ProjectTopologyWorktreeSnapshot
} from '../../shared/project-topology-api';

export async function loadProjectTopologyWorktreeSnapshot(
  signal?: AbortSignal
): Promise<ProjectTopologyWorktreeSnapshot> {
  throwIfAborted(signal);
  if (typeof window === 'undefined') {
    throw new Error('Project inventory requires a browser window.');
  }
  const baseUrl = resolveProjectSpaceApiBaseUrl(
    window.location.href,
    import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL
  );
  const requestUrl = new URL(
    `${baseUrl}/api/project-topology/inventory`,
    window.location.href
  );
  if (!isProjectSpaceApiRequestAllowed(window.location.href, requestUrl.toString())) {
    throw new Error('Project Space refused a portfolio request to an untrusted origin.');
  }
  const token = await refreshProjectSpaceAuthToken();
  throwIfAborted(signal);
  const response = await fetch(requestUrl, {
    cache: 'no-store',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    method: 'GET',
    redirect: 'error',
    signal
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      && typeof payload.error === 'string'
      ? payload.error
      : `Project inventory failed with ${response.status}.`;
    throw new Error(message);
  }
  return parseProjectTopologyWorktreeSnapshot(payload);
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error = new Error('Project inventory was cancelled.');
  error.name = 'AbortError';
  throw error;
}
