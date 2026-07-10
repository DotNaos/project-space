import { afterEach, describe, expect, test } from 'bun:test';
import {
  isConnectorCommandChannelAvailable,
  requestConnectorDirectory,
  requestConnectorFile,
  requestConnectorFileSystemRoot,
  requestConnectorModels,
  requestConnectorProjectWorktrees,
  requestConnectorTerminalCommand,
  streamConnectorCodexChat
} from '../server/connector-command-hub';
import {
  isConnectorHubMessage,
  isConnectorMachineMessage
} from '../server/connector-command-protocol';
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
});

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
          'filesystem.root',
          'terminal.run',
          'worktrees.list'
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
          models: [{
            description: 'Test model',
            displayName: 'Test Model',
            id: 'test-model',
            isDefault: true,
            model: 'test-model'
          }],
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
        return [{
          branchName: 'main',
          id: '/tmp/project',
          isBase: true,
          name: 'project',
          path: '/tmp/project',
          status: 'ready' as const
        }];
      },
      async getMachineFileSystemRoot() {
        return { defaultPath: '/tmp/projects', homePath: '/tmp', status: 'success' as const };
      },
      async readMachineDirectory(request) {
        return {
          entries: [{ kind: 'file' as const, name: 'note.txt', path: `${request.path}/note.txt` }],
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
    > as ProjectSpaceBackend;

    const hubBackend = createLocalProjectSpaceBackend();
    const server = await createProjectSpaceServer({ backend: hubBackend, host: '127.0.0.1', port: 0 });
    const bridge = startProjectConnectorWebSocket({
      backend,
      hubHttpUrl: server.origin,
      hubUrl: server.origin.replace(/^http/, 'ws') + '/api/connectors/socket'
    });

    try {
      await waitForChannel('test-machine');
      const catalogue = await requestConnectorModels({ cwd: '/tmp', machineId: 'test-machine' });
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

      const root = await requestConnectorFileSystemRoot({ machineId: 'test-machine' });
      expect(root).toEqual({ defaultPath: '/tmp/projects', homePath: '/tmp', status: 'success' });

      const directory = await requestConnectorDirectory({
        machineId: 'test-machine',
        path: '/tmp'
      });
      expect(directory.entries.map((entry) => entry.name)).toEqual(['note.txt']);

      const file = await requestConnectorFile({
        machineId: 'test-machine',
        path: '/tmp/note.txt'
      });
      expect(file.content).toBe('hello');

      const routedTerminal = await hubBackend.runMachineTerminalCommand({
        command: 'pwd',
        machineId: 'test-machine'
      });
      expect(routedTerminal.stdout).toBe('connector terminal');

      const routedWorktrees = await hubBackend.loadProjectWorktrees(
        '/tmp/project',
        'test-machine'
      );
      expect(routedWorktrees.map((worktree) => worktree.branchName)).toEqual(['main']);

      const routedDirectory = await hubBackend.readMachineDirectory({
        machineId: 'test-machine',
        path: '/tmp'
      });
      expect(routedDirectory.entries.map((entry) => entry.name)).toEqual(['note.txt']);
    } finally {
      await server.close();
      bridge.close();
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
    const server = await createProjectSpaceServer({ backend: hubBackend, host: '127.0.0.1', port: 0 });
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
    } finally {
      await server.close();
      bridge.close();
    }
  });
});
