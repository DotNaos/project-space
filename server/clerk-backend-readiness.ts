export type ClerkBackendReadiness =
  | { ready: true }
  | {
      code: 'missing' | 'rejected' | 'unavailable';
      message: string;
      ready: false;
    };

const ready: ClerkBackendReadiness = { ready: true };
const unavailableMessage =
  'Project Space login is temporarily unavailable because authentication is misconfigured.';

export function readyClerkBackend(): ClerkBackendReadiness {
  return ready;
}

export async function probeClerkBackendReadiness(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<ClerkBackendReadiness> {
  if (
    environment.PROJECT_SPACE_AUTH_DISABLED === '1' ||
    environment.PROJECT_SPACE_PREVIEW_MODE === '1'
  ) {
    return ready;
  }

  const secretKey = environment.CLERK_SECRET_KEY?.trim();
  if (!secretKey) {
    return {
      code: 'missing',
      message: unavailableMessage,
      ready: false
    };
  }

  try {
    const response = await fetchImpl('https://api.clerk.com/v1/users?limit=1', {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'User-Agent': 'project-space-auth-readiness'
      },
      signal: AbortSignal.timeout(10_000)
    });

    if (response.ok) {
      return ready;
    }

    return {
      code: response.status === 401 || response.status === 403 ? 'rejected' : 'unavailable',
      message: unavailableMessage,
      ready: false
    };
  } catch {
    return {
      code: 'unavailable',
      message: unavailableMessage,
      ready: false
    };
  }
}
