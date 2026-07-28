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
import { createGitHubIssueCreationRoutes } from './github-issue-creation-routes';
import { createGitHubIssueAttachmentContentRoute } from './github-issue-attachment-content-route';
import type { ProjectTopologyInventoryHttpHandler } from './project-topology/project-inventory-http';
import type { CodexMachineTasksHttpHandler } from './codex-machine-tasks/http';
import type { createConfiguredMachineReadinessHandler } from './machine-readiness/configured-runtime';
import type {
  createConfiguredCodexAuthorizationHandler
} from './codex-authorization/configured-runtime';
import type { createConfiguredRoadmapCliHandler } from './roadmap/roadmap-cli-runtime';
import type {
  createConfiguredProjectCatalogCliHandler
} from './project-catalog/project-catalog-cli-runtime';
import type {
  createConfiguredMachineDirectoryHandler
} from './machine-directory/configured-runtime';

interface ProjectSpaceApiHandlerOptions {
  codexAuthorization?: ReturnType<typeof createConfiguredCodexAuthorizationHandler>;
  codexSessions?: CodexSessionsHttpHandler;
  codexMachineTasks?: CodexMachineTasksHttpHandler;
  machineReadiness?: ReturnType<typeof createConfiguredMachineReadinessHandler>;
  machineDirectory?: ReturnType<typeof createConfiguredMachineDirectoryHandler>;
  machineConnection?: Pick<MachineConnectionRuntime, 'handleRequest'>;
  projectChat?: Pick<ProjectChatRuntime, 'handleRequest'>;
  projectCatalogCli?: ReturnType<typeof createConfiguredProjectCatalogCliHandler>;
  projectTopology?: ProjectTopologyInventoryHttpHandler;
  roadmapCli?: ReturnType<typeof createConfiguredRoadmapCliHandler>;
}

export function createProjectSpaceApiHandler(
  backend: ProjectSpaceBackend,
  options: ProjectSpaceApiHandlerOptions = {}
) {
  const handlePublicRoute = createProjectSpacePublicApiRoutes(backend);
  const handleCoreRoute = createProjectSpaceCoreApiRoutes(backend);
  const handleIntegrationRoute = createProjectSpaceIntegrationApiRoutes(backend);
  const handleIssueCreationRoute = createGitHubIssueCreationRoutes();
  const handleIssueAttachmentContentRoute = createGitHubIssueAttachmentContentRoute();

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

      if (options.codexMachineTasks && await options.codexMachineTasks(request, response, url)) {
        return true;
      }

      if (options.codexAuthorization &&
          await options.codexAuthorization(request, response, url)) {
        return true;
      }

      if (options.machineReadiness && await options.machineReadiness(request, response, url)) {
        return true;
      }

      if (options.machineDirectory && await options.machineDirectory(request, response, url)) {
        return true;
      }

      if (options.roadmapCli && await options.roadmapCli(request, response, url)) {
        return true;
      }

      if (
        options.projectCatalogCli &&
        await options.projectCatalogCli(request, response, url)
      ) {
        return true;
      }

      const authSession = await readAuthSessionFromRequest(request);
      const authMs = performance.now() - requestStartedAt;
      if (isProjectSpaceAuthRequired() && !authSession) {
        writeJson(response, 401, { error: 'Login required.' });
        return true;
      }

      return await runWithGitHubCatalogRequestTiming({ authMs, requestStartedAt }, () => runWithAuthSession(authSession, async () => {
        if (await handleIssueCreationRoute(request, response, url)) return true;
        if (await handleIssueAttachmentContentRoute(request, response, url)) return true;
        if (options.codexSessions && await options.codexSessions(request, response, url)) {
          return true;
        }
        if (options.projectTopology && await options.projectTopology(request, response, url)) {
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
