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
import type { MachineConnectionRuntime } from './machine-connection-runtime';
import type { ProjectChatRuntime } from './project-chat/runtime';
import { runWithGitHubCatalogRequestTiming } from './github-catalog-timing';
import type { CodexSessionsHttpHandler } from './codex-sessions-http';

interface ProjectSpaceApiHandlerOptions {
  codexSessions?: CodexSessionsHttpHandler;
  machineConnection?: Pick<MachineConnectionRuntime, 'handleRequest'>;
  projectChat?: Pick<ProjectChatRuntime, 'handleRequest'>;
}

export function createProjectSpaceApiHandler(
  backend: ProjectSpaceBackend,
  options: ProjectSpaceApiHandlerOptions = {}
) {
  const handlePublicRoute = createProjectSpacePublicApiRoutes(backend);
  const handleCoreRoute = createProjectSpaceCoreApiRoutes(backend);
  const handleIntegrationRoute = createProjectSpaceIntegrationApiRoutes(backend);

  return async function handleApiRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    const requestStartedAt = performance.now();
    try {
      if (request.method === 'OPTIONS') {
        writeEmpty(response);
        return true;
      }

      if (await handlePublicRoute(request, response, url)) {
        return true;
      }

      if (
        options.machineConnection &&
        await options.machineConnection.handleRequest(request, response, url)
      ) {
        return true;
      }

      if (options.projectChat && await options.projectChat.handleRequest(request, response, url)) {
        return true;
      }

      const authSession = await readAuthSessionFromRequest(request);
      const authMs = performance.now() - requestStartedAt;
      if (isProjectSpaceAuthRequired() && !authSession) {
        writeJson(response, 401, { error: 'Login required.' });
        return true;
      }

      return await runWithGitHubCatalogRequestTiming({ authMs, requestStartedAt }, () => runWithAuthSession(authSession, async () => {
        if (options.codexSessions && await options.codexSessions(request, response, url)) {
          return true;
        }
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
      }));
    } catch (error) {
      writeJson(response, error instanceof ProjectSpaceAccessError ? error.statusCode : 500, {
        error: error instanceof Error ? error.message : 'Unexpected backend error.'
      });
      return true;
    }
  };
}
