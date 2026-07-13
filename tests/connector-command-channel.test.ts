import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, test } from 'bun:test';
import {
  isConnectorCommandChannelAvailable,
  requestConnectorDevServerInspect,
  requestConnectorDevServerList,
  requestConnectorDevServerStart,
  requestConnectorDevServerStop,
  requestConnectorDirectory,
  requestConnectorFile,
  requestConnectorFileSystemRoot,
  requestConnectorFolderCreate,
  requestConnectorFolderDelete,
  requestConnectorFolderRename,
  requestConnectorModels,
  requestConnectorProjectWorktrees,
  requestConnectorTerminalCommand,
  registerLocalConnectorDevServerExecutor,
  streamConnectorCodexChat
} from '../server/connector-command-hub';
import {
  isConnectorHubMessage,
  isConnectorMachineMessage
} from '../server/connector-command-protocol';
import type { ConnectorDevServerAdapter } from '../server/connector-dev-server-contract';
import { startProjectConnectorWebSocket } from '../server/project-connector-websocket';
import { createProjectSpaceServer } from '../server/project-space-http';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';
import type {
  CodexChatStreamEvent,
  ConnectorProjectRegistryResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

const originalConfig = process.env.PROJECT_CONNECTOR_CONFIG;
const originalHubs = process.env.PROJECT_CONNECTOR_HUBS;
const originalToken = process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN;
const originalSigningPrivateKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;
const originalSigningPublicKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY;

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restore('PROJECT_CONNECTOR_CONFIG', originalConfig);
  restore('PROJECT_CONNECTOR_HUBS', originalHubs);
  restore('PROJECT_CONNECTOR_REGISTRATION_TOKEN', originalToken);
  restore('PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY', originalSigningPrivateKey);
  restore('PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY', originalSigningPublicKey);
});

function configureCommandSigningKeys() {
  const keys = generateKeyPairSync('ed25519');
  process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY = keys.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY = keys.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
}

async function waitForChannel(machineId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (isConnectorCommandChannelAvailable(machineId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Connector command channel did not become ready.');
}

describe('connector command channel', () => {
  test('rejects malformed registration tokens before they reach authentication', () => {
    expect(
      isConnectorHubMessage({
        payload: {
          connector: { machineId: 'attacker', machineName: 'Attacker' }
        },
        token: {},
        type: 'connector.register'
      })
    ).toBe(false);
    expect(
      isConnectorMachineMessage({
        id: 'bad-folder-delete',
        payload: { machineId: 'test-machine', paths: ['/tmp/folder', 42] },
        type: 'filesystem.folder.delete'
      })
    ).toBe(false);
    expect(
      isConnectorHubMessage({
        checkedAt: new Date().toISOString(),
        payload: {
          connector: { machineId: 'broken', machineName: 'Broken' }
        },
        token: 'valid-shape-token',
        type: 'connector.register'
      })
    ).toBe(false);
    expect(
      isConnectorMachineMessage({
        id: 'bad-terminal',
        payload: { machineId: 'test-machine' },
        type: 'terminal.run'
      })
    ).toBe(false);
    expect(
      isConnectorHubMessage({
        id: 'bad-terminal-result',
        payload: { stdout: 'missing result fields' },
        type: 'terminal.result'
      })
    ).toBe(false);
    expect(
      isConnectorHubMessage({
        id: 'bad-project-marker',
        payload: {
          entries: [
            {
              isProject: 'yes',
              kind: 'directory',
              name: 'repo',
              path: '/tmp/repo'
            }
          ],
          path: '/tmp',
          status: 'success'
        },
        type: 'filesystem.directory.result'
      })
    ).toBe(false);
  });

  test('uses the same signed execution boundary for a selected local machine', async () => {
    const actors: Array<{ generation: number; userId: string }> = [];
    const unregister = registerLocalConnectorDevServerExecutor('selected-local-machine', {
      async listDevServers() {
        throw new Error('not used');
      },
      async runDevServerCommand(request) {
        actors.push(request.actor);
        return {
          capability: 'configured',
          checkedAt: new Date().toISOString(),
          generation: request.actor.generation,
          localPort: 5173,
          localUrl: 'http://127.0.0.1:5173',
          machineId: request.machineId,
          projectId: request.projectId,
          publicPort: 45173,
          runTarget: request.runTarget,
          serverId: request.serverId,
          state: 'running',
          tailscaleIPv4: '100.80.135.9',
          tailscaleUrl: 'http://100.80.135.9:45173',
          worktreeId: request.worktreeId
        };
      }
    });

    try {
      const result = await requestConnectorDevServerStart(
        {
          allowedHosts: [],
          expectedHeadSha: 'a'.repeat(40),
          machineId: 'selected-local-machine',
          projectId: 'selected-local-machine:project',
          runTarget: 'dev',
          serverId: 'dev',
          worktreeId: 'wt_111111111111111111111111'
        },
        { generation: 9, userId: 'user_local' }
      );
      expect(result.tailscaleUrl).toBe('http://100.80.135.9:45173');
      expect(actors).toEqual([{ generation: 9, userId: 'user_local' }]);
    } finally {
      unregister();
    }
  });

  test('relays machine commands and filesystem reads without SSH', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';

    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: {
        capabilities: [
          'filesystem.directory',
          'filesystem.file',
          'filesystem.folder.create',
          'filesystem.folder.delete',
          'filesystem.folder.rename',
          'filesystem.root',
          'terminal.run',
          'worktrees.list',
          'worktrees.list.v2'
        ],
        machineId: 'test-machine',
        machineName: 'Test machine'
      },
      discovery: {
        groups: [],
        projects: [],
        rootItems: [],
        rootPath: '/tmp',
        structureViolations: []
      }
    };
    const backend = {
      async getConnectorProjectRegistry() {
        return registry;
      },
      async getCodexModels() {
        return {
          models: [
            {
              description: 'Test model',
              displayName: 'Test Model',
              id: 'test-model',
              isDefault: true,
              model: 'test-model'
            }
          ],
          status: 'success' as const
        };
      },
      async streamCodexChat(_request, emit) {
        emit({ delta: 'Hello', type: 'delta' });
        emit({ response: 'Hello', type: 'done' });
      },
      async runMachineTerminalCommand(request) {
        return {
          command: request.command,
          cwd: '/tmp',
          durationMs: 4,
          exitCode: 0,
          stderr: '',
          stdout: 'connector terminal'
        };
      },
      async loadProjectWorktrees() {
        return [
          {
            branchName: 'main',
            detached: false,
            headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            id: 'wt_111111111111111111111111',
            isBase: true,
            kind: 'project-managed' as const,
            locked: false,
            name: 'main',
            path: '/tmp/project',
            prunable: false,
            status: 'ready' as const
          },
          {
            detached: true,
            headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            id: 'wt_222222222222222222222222',
            isBase: false,
            kind: 'codex' as const,
            locked: true,
            lockedReason: 'in use',
            name: 'Codex · a281 · bbbbbbb',
            path: '/tmp/.codex-worktrees/a281/project',
            prunable: false,
            status: 'locked' as const,
            statusReason: 'in use'
          }
        ];
      },
      async getMachineFileSystemRoot() {
        return {
          defaultPath: '/tmp/projects',
          homePath: '/tmp',
          status: 'success' as const
        };
      },
      async readMachineDirectory(request) {
        return {
          entries: [
            {
              isProject: true,
              kind: 'directory' as const,
              name: 'repo',
              path: `${request.path}/repo`
            },
            {
              kind: 'file' as const,
              name: 'note.txt',
              path: `${request.path}/note.txt`
            }
          ],
          path: request.path,
          status: 'success' as const
        };
      },
      async readMachineFile(request) {
        return {
          content: 'hello',
          name: 'note.txt',
          path: request.path,
          status: 'success' as const
        };
      },
      async createMachineDirectory(request) {
        return {
          affectedPaths: [`${request.parentPath}/${request.name}`],
          status: 'success' as const
        };
      },
      async renameMachineDirectory(request) {
        return {
          affectedPaths: [`/tmp/${request.name}`],
          status: 'success' as const
        };
      },
      async deleteMachineDirectories(request) {
        return { affectedPaths: request.paths, status: 'success' as const };
      }
    } as Pick<
      ProjectSpaceBackend,
      | 'getConnectorProjectRegistry'
      | 'getCodexModels'
      | 'streamCodexChat'
      | 'runMachineTerminalCommand'
      | 'loadProjectWorktrees'
      | 'getMachineFileSystemRoot'
      | 'readMachineDirectory'
      | 'readMachineFile'
      | 'createMachineDirectory'
      | 'renameMachineDirectory'
      | 'deleteMachineDirectories'
    > as ProjectSpaceBackend;

    const hubBackend = createLocalProjectSpaceBackend();
    const server = await createProjectSpaceServer({
      backend: hubBackend,
      host: '127.0.0.1',
      port: 0
    });
    const bridge = startProjectConnectorWebSocket({
      backend,
      hubHttpUrl: server.origin,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });

    try {
      await waitForChannel('test-machine');
      const catalogue = await requestConnectorModels({
        cwd: '/tmp',
        machineId: 'test-machine'
      });
      expect(catalogue.models.map((model) => model.model)).toEqual(['test-model']);

      const events: CodexChatStreamEvent[] = [];
      await streamConnectorCodexChat(
        {
          cwd: '/tmp',
          machineId: 'test-machine',
          messages: [],
          model: 'test-model',
          prompt: 'Hello'
        },
        (event) => events.push(event)
      );
      expect(events).toEqual([
        { delta: 'Hello', type: 'delta' },
        { response: 'Hello', type: 'done' }
      ]);

      const terminal = await requestConnectorTerminalCommand({
        command: 'pwd',
        machineId: 'test-machine'
      });
      expect(terminal.stdout).toBe('connector terminal');

      const worktrees = await requestConnectorProjectWorktrees({
        machineId: 'test-machine',
        projectPath: '/tmp/project'
      });
      expect(worktrees.map((worktree) => worktree.branchName)).toEqual(['main']);

      const root = await requestConnectorFileSystemRoot({
        machineId: 'test-machine'
      });
      expect(root).toEqual({
        defaultPath: '/tmp/projects',
        homePath: '/tmp',
        status: 'success'
      });

      const directory = await requestConnectorDirectory({
        machineId: 'test-machine',
        path: '/tmp'
      });
      expect(directory.entries.map((entry) => [entry.name, entry.isProject])).toEqual([
        ['repo', true],
        ['note.txt', undefined]
      ]);

      const file = await requestConnectorFile({
        machineId: 'test-machine',
        path: '/tmp/note.txt'
      });
      expect(file.content).toBe('hello');

      const created = await requestConnectorFolderCreate({
        machineId: 'test-machine',
        name: 'created',
        parentPath: '/tmp'
      });
      expect(created.affectedPaths).toEqual(['/tmp/created']);

      const renamed = await requestConnectorFolderRename({
        machineId: 'test-machine',
        name: 'renamed',
        path: '/tmp/created'
      });
      expect(renamed.affectedPaths).toEqual(['/tmp/renamed']);

      const deleted = await requestConnectorFolderDelete({
        machineId: 'test-machine',
        paths: ['/tmp/renamed', '/tmp/second']
      });
      expect(deleted.affectedPaths).toEqual(['/tmp/renamed', '/tmp/second']);

      const routedTerminal = await hubBackend.runMachineTerminalCommand({
        command: 'pwd',
        machineId: 'test-machine'
      });
      expect(routedTerminal.stdout).toBe('connector terminal');

      const routedWorktrees = await hubBackend.loadProjectWorktrees(
        '/tmp/project',
        'test-machine'
      );
      expect(routedWorktrees).toHaveLength(2);
      expect(routedWorktrees[0]).toMatchObject({
        branchName: 'main',
        detached: false,
        id: 'wt_111111111111111111111111',
        status: 'ready'
      });
      expect(routedWorktrees[1]).toMatchObject({
        detached: true,
        id: 'wt_222222222222222222222222',
        status: 'locked'
      });

      const routedDirectory = await hubBackend.readMachineDirectory({
        machineId: 'test-machine',
        path: '/tmp'
      });
      expect(routedDirectory.entries.map((entry) => [entry.name, entry.isProject])).toEqual([
        ['repo', true],
        ['note.txt', undefined]
      ]);

      const routedDelete = await hubBackend.deleteMachineDirectories({
        machineId: 'test-machine',
        paths: ['/tmp/renamed']
      });
      expect(routedDelete.affectedPaths).toEqual(['/tmp/renamed']);
    } finally {
      await server.close();
      bridge.close();
    }
  });

  test('relays signed dev-server commands with actor and per-user host settings', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';
    configureCommandSigningKeys();

    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: {
        capabilities: [
          'dev-server.inspect',
          'dev-server.list',
          'dev-server.start',
          'dev-server.stop'
        ],
        machineId: 'dev-server-machine',
        machineName: 'Dev server machine'
      },
      discovery: {
        groups: [],
        projects: [],
        rootItems: [],
        rootPath: '/tmp',
        structureViolations: []
      }
    };
    const executions: Parameters<ConnectorDevServerAdapter['runDevServerCommand']>[0][] = [];
    const listExecutions: Parameters<ConnectorDevServerAdapter['listDevServers']>[0][] = [];
    const connectorBackend = {
      async getConnectorProjectRegistry() {
        return registry;
      },
      async listDevServers(request) {
        listExecutions.push(request);
        return {
          capability: 'configured' as const,
          checkedAt: new Date().toISOString(),
          generation: request.actor.generation,
          machineId: request.machineId,
          projectId: request.projectId,
          servers: [
            {
              capability: 'configured' as const,
              label: 'Development server',
              serverId: 'dev'
            }
          ],
          worktreeId: request.worktreeId
        };
      },
      async runDevServerCommand(request) {
        executions.push(request);
        const running = request.operation === 'start';
        return {
          capability: 'configured' as const,
          checkedAt: new Date().toISOString(),
          generation: request.actor.generation,
          machineId: request.machineId,
          projectId: request.projectId,
          runTarget: request.runTarget,
          serverId: request.serverId,
          state: running ? ('running' as const) : ('stopped' as const),
          worktreeId: request.worktreeId,
          ...(running
            ? {
                localPort: 5173,
                localUrl: 'http://127.0.0.1:5173',
                publicPort: 45173,
                tailscaleIPv4: '100.80.135.9',
                tailscaleUrl: 'http://100.80.135.9:45173'
              }
            : {})
        };
      }
    } as Pick<ProjectSpaceBackend, 'getConnectorProjectRegistry'> & ConnectorDevServerAdapter;
    const hubBackend = createLocalProjectSpaceBackend();
    const server = await createProjectSpaceServer({
      backend: hubBackend,
      host: '127.0.0.1',
      port: 0
    });
    const bridge = startProjectConnectorWebSocket({
      backend: connectorBackend as ProjectSpaceBackend & ConnectorDevServerAdapter,
      hubHttpUrl: server.origin,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });
    const request = {
      allowedHosts: ['Phone.Example', '100.80.135.9'],
      expectedHeadSha: 'a'.repeat(40),
      machineId: 'dev-server-machine',
      projectId: 'dev-server-machine:project-space',
      runTarget: 'dev',
      serverId: 'dev',
      worktreeId: 'wt_222222222222222222222222'
    };
    const actor = { generation: 4, userId: 'user_test' };

    try {
      await waitForChannel('dev-server-machine');
      const inventory = await requestConnectorDevServerList(
        {
          expectedHeadSha: request.expectedHeadSha,
          machineId: request.machineId,
          projectId: request.projectId,
          worktreeId: request.worktreeId
        },
        { generation: 0, userId: actor.userId }
      );
      const inspected = await requestConnectorDevServerInspect(request, actor);
      const started = await requestConnectorDevServerStart(request, actor);
      const stopped = await requestConnectorDevServerStop(request, actor);

      expect(inventory.servers).toEqual([
        {
          capability: 'configured',
          label: 'Development server',
          serverId: 'dev'
        }
      ]);
      expect(listExecutions).toHaveLength(1);
      expect(JSON.stringify(inventory)).not.toContain('command');
      expect(inspected.state).toBe('stopped');
      expect(started).toMatchObject({
        state: 'running',
        tailscaleUrl: 'http://100.80.135.9:45173'
      });
      expect(stopped.state).toBe('stopped');
      expect(executions.map((execution) => execution.operation)).toEqual([
        'inspect',
        'start',
        'stop'
      ]);
      expect(executions[1]).toMatchObject({
        actor: { generation: 4, userId: 'user_test' },
        allowedHosts: ['100.80.135.9', 'phone.example'],
        expectedHeadSha: 'a'.repeat(40),
        worktreeId: 'wt_222222222222222222222222'
      });
    } finally {
      await server.close();
      bridge.close();
    }
  });

  test('rejects a legacy worktree connector before sending an incompatible request', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';
    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: {
        capabilities: ['worktrees.list'],
        machineId: 'legacy-worktree-machine',
        machineName: 'Legacy worktree machine'
      },
      discovery: {
        groups: [],
        projects: [],
        rootItems: [],
        rootPath: '/tmp',
        structureViolations: []
      }
    };
    const connectorBackend = {
      async getConnectorProjectRegistry() {
        return registry;
      }
    } as ProjectSpaceBackend;
    const server = await createProjectSpaceServer({
      backend: createLocalProjectSpaceBackend(),
      host: '127.0.0.1',
      port: 0
    });
    const bridge = startProjectConnectorWebSocket({
      backend: connectorBackend,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });

    try {
      await waitForChannel('legacy-worktree-machine');
      await expect(
        requestConnectorProjectWorktrees({
          machineId: 'legacy-worktree-machine',
          projectPath: '/tmp/project'
        })
      ).rejects.toThrow('Update or restart');
    } finally {
      bridge.close();
      await server.close();
    }
  });

  test('returns a connector Git discovery failure without waiting for a timeout', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';
    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: {
        capabilities: ['worktrees.list', 'worktrees.list.v2'],
        machineId: 'failed-worktree-machine',
        machineName: 'Failed worktree machine'
      },
      discovery: {
        groups: [],
        projects: [],
        rootItems: [],
        rootPath: '/tmp',
        structureViolations: []
      }
    };
    const connectorBackend = {
      async getConnectorProjectRegistry() {
        return registry;
      },
      async loadProjectWorktrees() {
        throw new Error('git worktree list failed');
      }
    } as ProjectSpaceBackend;
    const server = await createProjectSpaceServer({
      backend: createLocalProjectSpaceBackend(),
      host: '127.0.0.1',
      port: 0
    });
    const bridge = startProjectConnectorWebSocket({
      backend: connectorBackend,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });

    try {
      await waitForChannel('failed-worktree-machine');
      await expect(
        requestConnectorProjectWorktrees({
          machineId: 'failed-worktree-machine',
          projectPath: '/tmp/project'
        })
      ).rejects.toThrow('git worktree list failed');
    } finally {
      bridge.close();
      await server.close();
    }
  });

  test('times out a dev-server command that never responds', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';
    configureCommandSigningKeys();
    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: {
        capabilities: ['dev-server.start'],
        machineId: 'timeout-machine',
        machineName: 'Timeout machine'
      },
      discovery: {
        groups: [],
        projects: [],
        rootItems: [],
        rootPath: '/tmp',
        structureViolations: []
      }
    };
    const connectorBackend = {
      async getConnectorProjectRegistry() {
        return registry;
      },
      async listDevServers() {
        throw new Error('not used');
      },
      async runDevServerCommand() {
        return await new Promise<never>(() => undefined);
      }
    } as Pick<ProjectSpaceBackend, 'getConnectorProjectRegistry'> & ConnectorDevServerAdapter;
    const server = await createProjectSpaceServer({
      backend: createLocalProjectSpaceBackend(),
      host: '127.0.0.1',
      port: 0
    });
    const bridge = startProjectConnectorWebSocket({
      backend: connectorBackend as ProjectSpaceBackend & ConnectorDevServerAdapter,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });

    try {
      await waitForChannel('timeout-machine');
      await expect(
        requestConnectorDevServerStart(
          {
            allowedHosts: [],
            expectedHeadSha: 'a'.repeat(40),
            machineId: 'timeout-machine',
            projectId: 'timeout-machine:project',
            runTarget: 'dev',
            serverId: 'dev',
            worktreeId: 'wt_333333333333333333333333'
          },
          { generation: 1, userId: 'user_timeout' },
          { timeoutMs: 30 }
        )
      ).rejects.toThrow('timed out');
    } finally {
      bridge.close();
      await server.close();
    }
  });

  test('fails an in-flight dev-server command when its connector disconnects', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';
    configureCommandSigningKeys();
    let markExecutionStarted!: () => void;
    const executionStarted = new Promise<void>((resolve) => {
      markExecutionStarted = resolve;
    });
    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: {
        capabilities: ['dev-server.start'],
        machineId: 'disconnect-machine',
        machineName: 'Disconnect machine'
      },
      discovery: {
        groups: [],
        projects: [],
        rootItems: [],
        rootPath: '/tmp',
        structureViolations: []
      }
    };
    const connectorBackend = {
      async getConnectorProjectRegistry() {
        return registry;
      },
      async listDevServers() {
        throw new Error('not used');
      },
      async runDevServerCommand() {
        markExecutionStarted();
        return await new Promise<never>(() => undefined);
      }
    } as Pick<ProjectSpaceBackend, 'getConnectorProjectRegistry'> & ConnectorDevServerAdapter;
    const server = await createProjectSpaceServer({
      backend: createLocalProjectSpaceBackend(),
      host: '127.0.0.1',
      port: 0
    });
    const bridge = startProjectConnectorWebSocket({
      backend: connectorBackend as ProjectSpaceBackend & ConnectorDevServerAdapter,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });

    try {
      await waitForChannel('disconnect-machine');
      const result = requestConnectorDevServerStart(
        {
          allowedHosts: [],
          expectedHeadSha: 'a'.repeat(40),
          machineId: 'disconnect-machine',
          projectId: 'disconnect-machine:project',
          runTarget: 'dev',
          serverId: 'dev',
          worktreeId: 'wt_444444444444444444444444'
        },
        { generation: 1, userId: 'user_disconnect' },
        { timeoutMs: 5_000 }
      );
      await executionStarted;
      bridge.close();
      await expect(result).rejects.toThrow('not connected');
    } finally {
      bridge.close();
      await server.close();
    }
  });

  test('rejects unsupported commands immediately for older connectors', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';

    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: { machineId: 'older-machine', machineName: 'Older machine' },
      discovery: {
        groups: [],
        projects: [],
        rootItems: [],
        rootPath: '/tmp',
        structureViolations: []
      }
    };
    const connectorBackend = {
      async getConnectorProjectRegistry() {
        return registry;
      }
    } as Pick<ProjectSpaceBackend, 'getConnectorProjectRegistry'> as ProjectSpaceBackend;
    const hubBackend = createLocalProjectSpaceBackend();
    const server = await createProjectSpaceServer({
      backend: hubBackend,
      host: '127.0.0.1',
      port: 0
    });
    const bridge = startProjectConnectorWebSocket({
      backend: connectorBackend,
      hubHttpUrl: server.origin,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });

    try {
      await waitForChannel('older-machine');
      const startedAt = Date.now();
      const result = await hubBackend.runMachineTerminalCommand({
        command: 'pwd',
        machineId: 'older-machine'
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Update or restart');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await expect(
        requestConnectorDevServerStart(
          {
            allowedHosts: [],
            expectedHeadSha: 'a'.repeat(40),
            machineId: 'older-machine',
            projectId: 'older-machine:project',
            runTarget: 'dev',
            serverId: 'dev',
            worktreeId: 'wt_555555555555555555555555'
          },
          { generation: 1, userId: 'user_test' }
        )
      ).rejects.toThrow('Update or restart');
    } finally {
      await server.close();
      bridge.close();
    }
  });
});
