import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  createConnectorCommandUpgradeHandler,
  isConnectorCommandChannelAvailable
} from '../server/connector-command-hub';
import {
  isConnectorMachineMessage,
  isConnectorProjectRegistryPayload
} from '../server/connector-command-protocol';
import {
  ConnectorRuntimeDecisionWriter,
  connectorRuntimeSupervisorDecisionSchema,
  isConnectorRuntimeSupervisorDecision
} from '../server/connector-runtime-registration-decision';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

const environmentKeys = [
  'PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY',
  'PROJECT_CONNECTOR_RUNTIME_CONTROL_FILE',
  'PROJECT_CONNECTOR_RUNTIME_DECISION_FILE',
  'PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID',
  'PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE',
  'PROJECT_CONNECTOR_RUNTIME_STAGING_DIR',
  'PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY',
  'PROJECT_SPACE_INSTALL_SOURCE'
] as const;
const originalEnvironment = Object.fromEntries(
  environmentKeys.map((key) => [key, process.env[key]])
);

afterEach(() => {
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function registry(
  machineId: string,
  maintenance?: { operationId: string; state: 'pending-health-check' | 'rolled-back' }
): ConnectorProjectRegistryResult {
  return {
    checkedAt: '2026-07-14T00:00:00.000Z',
    connector: {
      capabilities: ['runtime.restart', 'runtime.update'],
      machineId,
      machineName: machineId,
      runtime: {
        architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
        buildId: '1'.repeat(40),
        bundleVersions: { connector: '1.2.3', machineTools: '1.2.3', projectCli: '1.2.3' },
        channel: 'stable',
        instanceId: 'stable-machine-instance',
        lastCheckedAt: '2026-07-14T00:00:00.000Z',
        ...(maintenance ? { maintenance } : {}),
        platform: process.platform === 'darwin' ? 'darwin' :
          process.platform === 'win32' ? 'windows' : 'linux',
        protocolVersion: '2',
        releaseId: 'v1.2.3',
        source: 'managed',
        version: '1.2.3'
      }
    },
    discovery: {
      groups: [], projects: [], rootItems: [], rootPath: '/tmp', structureViolations: []
    }
  };
}

async function listeningServer(
  options: Parameters<typeof createConnectorCommandUpgradeHandler>[0]
) {
  const commands = createConnectorCommandUpgradeHandler(options);
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    if (!commands.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not expose a port.');
  return { commands, origin: `http://127.0.0.1:${address.port}`, server };
}

describe('connector runtime reconnect decisions', () => {
  test('strictly validates maintenance evidence and registered decisions', () => {
    const valid = registry('runtime-validation', {
      operationId: 'operation-191', state: 'pending-health-check'
    });
    expect(isConnectorProjectRegistryPayload(valid)).toBe(true);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: {
        ...valid.connector,
        runtime: { ...valid.connector.runtime!, maintenance: {
          operationId: 'operation-191', state: 'pending-health-check', url: 'https://attacker.test'
        } }
      }
    })).toBe(false);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: {
        ...valid.connector,
        runtime: { ...valid.connector.runtime!, buildId: `${'1'.repeat(40)}\nspoofed` }
      }
    })).toBe(false);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: {
        ...valid.connector,
        runtime: { ...valid.connector.runtime!, version: 'latest' }
      }
    })).toBe(false);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: {
        ...valid.connector,
        runtime: { ...valid.connector.runtime!, releaseId: 'v9.9.9' }
      }
    })).toBe(false);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: {
        ...valid.connector,
        runtime: { ...valid.connector.runtime!, bundleVersions: {
          ...valid.connector.runtime!.bundleVersions, machineTools: 'main'
        } }
      }
    })).toBe(false);
    expect(isConnectorProjectRegistryPayload({
      ...valid,
      connector: {
        ...valid.connector,
        runtime: { ...valid.connector.runtime!, lastCheckedAt: 'not-a-date' }
      }
    })).toBe(false);
    expect(isConnectorMachineMessage({
      generation: 7,
      maintenance: { action: 'commit', operationId: 'operation-191' },
      type: 'connector.registered'
    })).toBe(true);
    expect(isConnectorMachineMessage({
      generation: 7,
      maintenance: { action: 'commit', operationId: 'operation-191', path: '/tmp/evil' },
      type: 'connector.registered'
    })).toBe(false);
  });

  test('publishes only a matching no-overwrite supervisor decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-runtime-decision-'));
    const directory = join(root, '.project-space-machine-tools', 'maintenance');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'decision.json');
    const writer = new ConnectorRuntimeDecisionWriter(path);
    const evidence = { operationId: 'operation-191', state: 'pending-health-check' } as const;
    try {
      await writer.accept(evidence, { action: 'commit', operationId: 'operation-191' });
      const decision = JSON.parse(await readFile(path, 'utf8'));
      expect(decision).toEqual({
        action: 'commit', operationId: 'operation-191',
        schema: connectorRuntimeSupervisorDecisionSchema
      });
      expect(isConnectorRuntimeSupervisorDecision(decision)).toBe(true);
      await expect(writer.accept(evidence, {
        action: 'rollback', operationId: 'operation-191'
      })).rejects.toThrow();
      expect(JSON.parse(await readFile(path, 'utf8')).action).toBe('commit');
      expect(() => new ConnectorRuntimeDecisionWriter(join(directory, 'arbitrary.json')))
        .toThrow('decision path is invalid');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('fails registration closed when the persisted operation has no matching decision', async () => {
    const hub = await listeningServer({
      async authenticateConnectorCredential() { return true; },
      async decideConnectorRuntimeMaintenance() {
        return { action: 'commit', operationId: 'different-operation' };
      }
    });
    const socket = new WebSocket(hub.origin.replace(/^http/, 'ws') + '/api/connectors/socket');
    await once(socket, 'open');
    const payload = registry('runtime-rejected', {
      operationId: 'operation-191', state: 'pending-health-check'
    });
    socket.send(JSON.stringify({ payload, token: 'credential', type: 'connector.register' }));
    try {
      const [code] = await once(socket, 'close') as [number, Buffer];
      expect(code).toBe(1008);
      expect(isConnectorCommandChannelAvailable('runtime-rejected')).toBe(false);
    } finally {
      hub.server.closeAllConnections();
      await hub.commands.close();
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
    }
  });

});
