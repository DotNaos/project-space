import { afterEach, describe, expect, test } from 'bun:test';
import {
  isConnectorCommandChannelAvailable,
  requestConnectorModels,
  streamConnectorCodexChat
} from '../server/connector-command-hub';
import { isConnectorHubMessage } from '../server/connector-command-protocol';
import { startProjectConnectorWebSocket } from '../server/project-connector-websocket';
import { createProjectSpaceServer } from '../server/project-space-http';
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
  });

  test('relays model catalogues and streamed chat without SSH', async () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    delete process.env.PROJECT_CONNECTOR_HUBS;
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'test-connector-token';

    const registry: ConnectorProjectRegistryResult = {
      checkedAt: new Date().toISOString(),
      connector: {
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
      }
    } as Pick<
      ProjectSpaceBackend,
      'getConnectorProjectRegistry' | 'getCodexModels' | 'streamCodexChat'
    > as ProjectSpaceBackend;

    const server = await createProjectSpaceServer({ backend, host: '127.0.0.1', port: 0 });
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
    } finally {
      await server.close();
      bridge.close();
    }
  });
});
