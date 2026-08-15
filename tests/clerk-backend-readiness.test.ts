import { describe, expect, test } from 'bun:test';

import { probeClerkBackendReadiness } from '../server/clerk-backend-readiness';
import { createProjectSpaceServer } from '../server/project-space-http';

const secretEnvironment = { CLERK_SECRET_KEY: 'test-secret' } as NodeJS.ProcessEnv;

describe('Clerk backend readiness', () => {
  test('accepts a credential that Clerk accepts', async () => {
    const result = await probeClerkBackendReadiness(
      secretEnvironment,
      async () => new Response('{}', { status: 200 })
    );

    expect(result).toEqual({ ready: true });
  });

  test('reports a rejected credential without exposing the credential or response', async () => {
    const result = await probeClerkBackendReadiness(
      secretEnvironment,
      async () => new Response('private upstream detail', { status: 401 })
    );

    expect(result).toEqual({
      code: 'rejected',
      message: 'Project Space login is temporarily unavailable because authentication is misconfigured.',
      ready: false
    });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(JSON.stringify(result)).not.toContain('private upstream detail');
  });

  test('keeps the login surface available while marking the service unhealthy', async () => {
    const authReadiness = await probeClerkBackendReadiness(
      secretEnvironment,
      async () => new Response('', { status: 403 })
    );
    const server = await createProjectSpaceServer({
      authReadiness,
      host: '127.0.0.1',
      port: 0
    });

    try {
      const health = await fetch(`${server.origin}/api/health`);
      const session = await fetch(`${server.origin}/api/auth/session`);

      expect(health.status).toBe(503);
      expect(await health.json()).toEqual({
        error: 'Project Space login is temporarily unavailable because authentication is misconfigured.',
        ok: false
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toEqual({
        authenticated: false,
        authRequired: true,
        message: 'Project Space login is temporarily unavailable because authentication is misconfigured.'
      });
    } finally {
      await server.close();
    }
  });
});
