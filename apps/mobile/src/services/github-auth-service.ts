import type { AuthSession } from '../domain/models';

const authServerOrigin =
  process.env.EXPO_PUBLIC_AUTH_SERVER_ORIGIN ?? 'http://127.0.0.1:8787';

function readCurrentUrl() {
  if (typeof window === 'undefined') {
    return null;
  }

  return new URL(window.location.href);
}

export async function fetchAuthHealth() {
  const response = await fetch(`${authServerOrigin}/health`);

  if (!response.ok) {
    throw new Error('Auth server is not reachable.');
  }

  return (await response.json()) as {
    configured: boolean;
    callbackUrl: string;
  };
}

export function beginGitHubLogin() {
  if (typeof window === 'undefined') {
    return;
  }

  const returnTo = `${window.location.origin}${window.location.pathname}`;
  const loginUrl = new URL(`${authServerOrigin}/auth/github/start`);
  loginUrl.searchParams.set('returnTo', returnTo);
  window.location.assign(loginUrl.toString());
}

export function readOAuthCallbackParams() {
  const currentUrl = readCurrentUrl();

  return {
    sessionId: currentUrl?.searchParams.get('oauth_session') ?? null,
    error: currentUrl?.searchParams.get('oauth_error') ?? null,
  };
}

export function clearOAuthCallbackParams() {
  const currentUrl = readCurrentUrl();

  if (!currentUrl || typeof window === 'undefined') {
    return;
  }

  currentUrl.searchParams.delete('oauth_session');
  currentUrl.searchParams.delete('oauth_error');
  window.history.replaceState({}, '', currentUrl.toString());
}

export async function consumeOAuthSession(sessionId: string): Promise<AuthSession> {
  const response = await fetch(
    `${authServerOrigin}/auth/github/session?id=${encodeURIComponent(sessionId)}`
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error ?? 'OAuth session exchange failed.');
  }

  return payload as AuthSession;
}
