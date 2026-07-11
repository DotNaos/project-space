import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from './local-auth-store';
import { createProjectSpaceCoreApiRoutes } from './project-space-api-core-routes';
import { createProjectSpaceIntegrationApiRoutes } from './project-space-api-integration-routes';
import { createProjectSpacePublicApiRoutes } from './project-space-api-public-routes';
import { ProjectSpaceAccessError } from './authorized-project-space-backend';
import { writeEmpty, writeJson } from './project-space-http-response';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

export function createProjectSpaceApiHandler(backend: ProjectSpaceBackend) {
  const handlePublicRoute = createProjectSpacePublicApiRoutes(backend);
  const handleCoreRoute = createProjectSpaceCoreApiRoutes(backend);
  const handleIntegrationRoute = createProjectSpaceIntegrationApiRoutes(backend);

  return async function handleApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    try {
      if (request.method === 'OPTIONS') {
        writeEmpty(response);
        return true;
      }

      if (await handlePublicRoute(request, response, url)) {
        return true;
      }

      const authSession = await readAuthSessionFromRequest(request);
      if (isProjectSpaceAuthRequired() && !authSession) {
        writeJson(response, 401, { error: 'Login required.' });
        return true;
      }

      return await runWithAuthSession(authSession, async () => {
        if (
          await handleCoreRoute(
            request,
            response,
            url,
            authSession?.userId ?? 'local-development-user'
          )
        ) {
          return true;
        }
        return await handleIntegrationRoute(request, response, url);
      });
    } catch (error) {
      writeJson(response, error instanceof ProjectSpaceAccessError ? error.statusCode : 500, {
        error: error instanceof Error ? error.message : 'Unexpected backend error.'
      });
      return true;
    }
  };
}
