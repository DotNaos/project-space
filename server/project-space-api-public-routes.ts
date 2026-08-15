import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getProjectSpaceAuthSessionResult,
  readAuthTokenFromRequest,
  revokeProjectSpaceAuthSession
} from './local-auth-store';
import { writeJson } from './project-space-http-response';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import { readExactPullRequestChangelogSource } from './pr-preview-changelog-source';
import { releaseChangelogForVersion } from './release-changelog';
import {
  readyClerkBackend,
  type ClerkBackendReadiness
} from './clerk-backend-readiness';

const exactSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createProjectSpacePublicApiRoutes(
  backend: ProjectSpaceBackend,
  authReadiness: ClerkBackendReadiness = readyClerkBackend()
) {
  return async function handleProjectSpacePublicApiRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      if (!authReadiness.ready) {
        writeJson(response, 503, {
          error: authReadiness.message,
          ok: false
        });
        return true;
      }
      writeJson(response, 200, { ok: true });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/app/meta') {
      writeJson(response, 200, await backend.getAppMeta());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/app/releases') {
      try {
        const meta = await backend.getAppMeta();
        writeJson(response, 200, await releaseChangelogForVersion(meta.version));
      } catch {
        writeJson(response, 503, { error: 'Release changelog is temporarily unavailable.' });
      }
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/app/changelog') {
      const meta = await backend.getAppMeta();
      if (meta.preview?.state !== 'verified') {
        writeJson(response, 409, { error: 'Exact pull request identity is unavailable.' });
        return true;
      }
      const identity = meta.preview.identity;
      const source = readExactPullRequestChangelogSource(
        exactSourceRoot,
        identity.pullRequestNumber
      );
      if (!source) {
        writeJson(response, 503, { error: 'Exact pull request changelog is unavailable.' });
        return true;
      }
      writeJson(response, 200, {
        identity,
        source
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/session') {
      if (!authReadiness.ready) {
        writeJson(response, 200, {
          authenticated: false,
          authRequired: true,
          message: authReadiness.message
        });
        return true;
      }
      writeJson(
        response,
        200,
        await getProjectSpaceAuthSessionResult(readAuthTokenFromRequest(request))
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      revokeProjectSpaceAuthSession();
      writeJson(response, 200, { ok: true });
      return true;
    }

    return false;
  };
}
