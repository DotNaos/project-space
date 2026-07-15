import { expect, test } from 'bun:test';

import {
  isConnectorCommandChannelAvailable,
  requestConnectorProjectWorktrees
} from '../server/connector-command-hub';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';
import { startProjectConnectorWebSocket } from '../server/project-connector-websocket';
import { createProjectSpaceServer } from '../server/project-space-http';
import type {
  ConnectorProjectRegistryResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

test('cancels an in-flight connector worktree inventory', async () => {
  const originalConfig = process.env.PROJECT_CONNECTOR_CONFIG;
  const originalHubs = process.env.PROJECT_CONNECTOR_HUBS;
  const originalToken = process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN;
  process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
  delete process.env.PROJECT_CONNECTOR_HUBS;
  process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';

  let markStarted!: () => void;
  let markAborted!: () => void;
  let connectorSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const registry: ConnectorProjectRegistryResult = {
    checkedAt: new Date().toISOString(),
    connector: {
      capabilities: ['worktrees.list', 'worktrees.list.v2'],
      machineId: 'cancel-worktree-machine',
      machineName: 'Cancel worktree machine'
    },
    discovery: {
      groups: [], projects: [], rootItems: [], rootPath: '/tmp', structureViolations: []
    }
  };
  const connectorBackend = {
    async getConnectorProjectRegistry() {
      return registry;
    },
    async loadProjectWorktrees(
      _projectPath: string,
      _machineId?: string,
      options?: { signal?: AbortSignal }
    ) {
      connectorSignal = options?.signal;
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          markAborted();
          reject(options.signal?.reason);
        }, { once: true });
      });
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
    await waitForChannel('cancel-worktree-machine');
    const controller = new AbortController();
    const request = requestConnectorProjectWorktrees({
      machineId: 'cancel-worktree-machine',
      projectPath: '/tmp/project'
    }, { signal: controller.signal });
    await started;
    controller.abort(new Error('caller cancelled'));
    await expect(request).rejects.toThrow('caller cancelled');
    await aborted;
    expect(connectorSignal?.aborted).toBe(true);
  } finally {
    bridge.close();
    await server.close();
    restore('PROJECT_CONNECTOR_CONFIG', originalConfig);
    restore('PROJECT_CONNECTOR_HUBS', originalHubs);
    restore('PROJECT_CONNECTOR_REGISTRATION_TOKEN', originalToken);
  }
});

async function waitForChannel(machineId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (isConnectorCommandChannelAvailable(machineId)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Connector command channel did not become ready.');
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
