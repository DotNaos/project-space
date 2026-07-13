import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  requestConnectorDevServerInspect,
  requestConnectorDevServerList,
  requestConnectorDevServerStart,
  requestConnectorDevServerStop,
  requestConnectorWorktreeAction
} from './connector-command-hub';
import { createConnectorInstaller, requestPublicOrigin } from './connector-installation';
import { createDevServerService } from './dev-server-service';
import { createWorktreeActionService } from './worktree-action-service';
import {
  createDevServerSession,
  isDatabaseConfigured,
  isMachineClaimed,
  listConnectorCredentials,
  listDevServerSessions,
  readMachineMembership,
  readProjectRunSettings,
  revokeConnectorCredential,
  transitionDevServerSession,
  upsertProjectRunSettings
} from './local-database-store';
import { getCurrentAuthSession, isProjectSpaceAuthRequired } from './local-auth-store';
import { readJson, writeJson } from './project-space-http-response';
import type {
  DevServerActionRequest,
  DevServerInspectRequest,
  WorktreeMaterializeRequest,
  WorktreeSetupInspectRequest,
  WorktreeSetupRunRequest,
  MachineDirectoryCreateRequest,
  MachineDirectoryDeleteRequest,
  MachineDirectoryRenameRequest,
  MachineFileSystemDirectoryRequest,
  MachineFileSystemFileRequest,
  MachineFileSystemRequest,
  OpenPathInAppRequest,
  ProjectCliCommandRequest,
  ProjectCliCommandResult,
  ProjectDirectorySelection,
  ProjectRunSettingsUpdateRequest,
  ProjectSpaceBackend,
  ProjectsState,
  ProjectStructureActionRequest,
  ProjectTrashRestoreRequest
} from '../src/shared/project-space-api';
import {
  discoverProjectWorktrees,
  reconcileProjectWorktreeDiscovery
} from './project-worktree-discovery';

export function createProjectSpaceCoreApiRoutes(backend: ProjectSpaceBackend) {
  const currentUserId = () => {
    const session = getCurrentAuthSession();
    if (session?.userId) return session.userId;
    if (!isProjectSpaceAuthRequired()) return 'local-development-user';
    throw new Error('Login required.');
  };
  const devServers = createDevServerService({
    backend,
    connector: {
      inspect: requestConnectorDevServerInspect,
      list: requestConnectorDevServerList,
      start: requestConnectorDevServerStart,
      stop: requestConnectorDevServerStop
    },
    database: {
      createDevServerSession,
      isConfigured: isDatabaseConfigured,
      isMachineClaimed,
      listDevServerSessions,
      readMachineMembership,
      readProjectRunSettings,
      transitionDevServerSession,
      upsertProjectRunSettings
    },
    userId: currentUserId
  });
  const worktreeActions = createWorktreeActionService({
    backend,
    connector: { run: requestConnectorWorktreeAction },
    database: { isConfigured: isDatabaseConfigured, readMachineMembership },
    userId: currentUserId
  });

  return async function handleProjectSpaceCoreApiRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    userId: string
  ) {
    if (request.method === 'GET' && url.pathname === '/api/deployed-environments/status') {
      const repositoryFullName = url.searchParams.get('repositoryFullName');
      if (!repositoryFullName) {
        writeJson(response, 400, { error: 'Missing repositoryFullName.' });
        return true;
      }
      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(response, 200, await backend.getDeployedEnvironmentStatus(repositoryFullName));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/connectors/install-command') {
      response.setHeader('Cache-Control', 'no-store');
      writeJson(
        response,
        200,
        await createConnectorInstaller(requestPublicOrigin(request), userId)
      );
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/connectors/credentials') {
      response.setHeader('Cache-Control', 'no-store');
      writeJson(response, 200, {
        credentials: isDatabaseConfigured() ? await listConnectorCredentials(userId) : []
      });
      return true;
    }

    const connectorCredentialMatch = url.pathname.match(
      /^\/api\/connectors\/credentials\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    );
    if (request.method === 'DELETE' && connectorCredentialMatch?.[1]) {
      response.setHeader('Cache-Control', 'no-store');
      writeJson(response, 200, {
        revoked: await revokeConnectorCredential({
          credentialId: connectorCredentialMatch[1],
          userId
        })
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/launcher/apps') {
      writeJson(response, 200, await backend.loadLauncherApps());
      return true;
    }

    const iconMatch = url.pathname.match(/^\/api\/launcher\/apps\/([^/]+)\/icon$/);
    if (request.method === 'GET' && iconMatch?.[1]) {
      writeJson(response, 200, {
        iconDataUrl: await backend.loadLauncherAppIcon(decodeURIComponent(iconMatch[1]))
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/launcher/open-path') {
      const payload = await readJson<OpenPathInAppRequest>(request);
      writeJson(response, 200, await backend.openPathInApp(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/projects/discovery') {
      writeJson(response, 200, await backend.loadProjectDiscovery());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/projects/structure-actions') {
      const payload = await readJson<ProjectStructureActionRequest>(request);
      writeJson(response, 200, await backend.applyProjectStructureAction(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/projects/trash') {
      writeJson(response, 200, await backend.listProjectTrash());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/projects/trash/restore') {
      const payload = await readJson<ProjectTrashRestoreRequest>(request);
      writeJson(response, 200, await backend.restoreProjectTrashEntry(payload));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/projects/state') {
      writeJson(response, 200, await backend.loadProjectsState());
      return true;
    }

    if (request.method === 'PUT' && url.pathname === '/api/projects/state') {
      await backend.saveProjectsState(await readJson<ProjectsState>(request));
      writeJson(response, 200, {});
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/projects/worktrees') {
      const projectId = url.searchParams.get('projectId');
      const machineId = url.searchParams.get('machineId') ?? undefined;
      if (!projectId) {
        writeJson(response, 400, { error: 'Missing projectId.' });
        return true;
      }
      const projectDiscovery = await backend.loadProjectDiscovery();
      const project = projectDiscovery.projects.find(
        (candidate) =>
          candidate.id === projectId && (!machineId || candidate.machineId === machineId)
      );
      if (!project) {
        writeJson(response, 200, {
          checkedAt: new Date().toISOString(),
          message: 'Project not found on the selected machine.',
          reason: 'project-mismatch',
          state: 'blocked'
        });
        return true;
      }
      const worktreeDiscovery = await discoverProjectWorktrees({
        projectPath: project.rootPath,
        scan: () => backend.loadProjectWorktrees(project.rootPath, machineId)
      });
      writeJson(
        response,
        200,
        reconcileProjectWorktreeDiscovery(worktreeDiscovery, Boolean(project.gitStatus))
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/dev-servers/inspect') {
      writeJson(
        response,
        200,
        await devServers.inspect(await readJson<DevServerInspectRequest>(request))
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/worktrees/materialize') {
      writeJson(
        response,
        200,
        await worktreeActions.materialize(await readJson<WorktreeMaterializeRequest>(request))
      );
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/worktrees/setup/inspect') {
      writeJson(
        response,
        200,
        await worktreeActions.inspectSetup(await readJson<WorktreeSetupInspectRequest>(request))
      );
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/worktrees/setup/run') {
      writeJson(
        response,
        200,
        await worktreeActions.runSetup(await readJson<WorktreeSetupRunRequest>(request))
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/dev-servers/start') {
      writeJson(
        response,
        200,
        await devServers.start(await readJson<DevServerActionRequest>(request))
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/dev-servers/stop') {
      writeJson(
        response,
        200,
        await devServers.stop(await readJson<DevServerActionRequest>(request))
      );
      return true;
    }

    if (request.method === 'PUT' && url.pathname === '/api/dev-servers/settings') {
      writeJson(
        response,
        200,
        await devServers.updateSettings(await readJson<ProjectRunSettingsUpdateRequest>(request))
      );
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/projectctl/overview') {
      const projectPath = url.searchParams.get('projectPath');
      if (!projectPath) {
        writeJson(response, 400, { error: 'Missing projectPath.' });
        return true;
      }

      writeJson(response, 200, await backend.loadProjectctlOverview(projectPath));
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/projectctl/preview') {
      const projectPath = url.searchParams.get('projectPath');
      if (!projectPath) {
        writeJson(response, 400, { error: 'Missing projectPath.' });
        return true;
      }

      writeJson(response, 200, await backend.loadProjectctlPreview(projectPath));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/projects/select-directory') {
      const selection: ProjectDirectorySelection = await backend.selectProjectDirectory();
      writeJson(response, 200, selection);
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/filesystem/directory') {
      const path = url.searchParams.get('path');
      if (!path) {
        writeJson(response, 400, { error: 'Missing path.' });
        return true;
      }

      writeJson(response, 200, await backend.readDirectory(path));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/machines/filesystem/root') {
      const payload = await readJson<MachineFileSystemRequest>(request);
      writeJson(response, 200, await backend.getMachineFileSystemRoot(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/machines/filesystem/directory') {
      const payload = await readJson<MachineFileSystemDirectoryRequest>(request);
      writeJson(response, 200, await backend.readMachineDirectory(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/machines/filesystem/file') {
      const payload = await readJson<MachineFileSystemFileRequest>(request);
      writeJson(response, 200, await backend.readMachineFile(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/machines/filesystem/folders/create') {
      const payload = await readJson<MachineDirectoryCreateRequest>(request);
      writeJson(response, 200, await backend.createMachineDirectory(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/machines/filesystem/folders/rename') {
      const payload = await readJson<MachineDirectoryRenameRequest>(request);
      writeJson(response, 200, await backend.renameMachineDirectory(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/machines/filesystem/folders/delete') {
      const payload = await readJson<MachineDirectoryDeleteRequest>(request);
      writeJson(response, 200, await backend.deleteMachineDirectories(payload));
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/codex/open-skills') {
      writeJson(response, 200, await backend.openCodexSkills());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/codex/status') {
      writeJson(response, 200, await backend.getCodexStatus());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/connectors/overview') {
      writeJson(response, 200, await backend.getConnectorOverview());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/connectors/project-registry') {
      writeJson(response, 200, await backend.getConnectorProjectRegistry());
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/project-cli/run') {
      const payload = await readJson<ProjectCliCommandRequest>(request);
      if (payload.machineId) {
        const overview = await backend.getConnectorOverview();
        const machine = overview.machines.find((entry) => entry.id === payload.machineId);
        if (!machine) {
          writeJson(response, 404, {
            error: `Machine ${payload.machineId} was not found.`
          });
          return true;
        }
        if (machine.connector.status !== 'local') {
          writeJson(response, 200, {
            args: [],
            command: payload.command,
            cwd: payload.cwd,
            durationMs: 0,
            exitCode: 1,
            stderr:
              'Project CLI writes can only run on the local connector in this build. Select a local dev machine or add remote connector command routing.',
            stdout: ''
          } satisfies ProjectCliCommandResult);
          return true;
        }
      }

      writeJson(response, 200, await backend.runProjectCliCommand(payload));
      return true;
    }

    return false;
  };
}
