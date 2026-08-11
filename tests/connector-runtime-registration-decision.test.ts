import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import { connectorRuntimeCredentialVersion } from '../server/connector-runtime-credential';
import { connectorRuntimeSupervisorOutcomeSchema } from '../server/connector-runtime-supervisor-outcome';
import { startProjectConnectorWebSocket } from '../server/project-connector-websocket';
import type {
  ConnectorProjectRegistryResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

const environmentKeys = [
  'PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY',
  'PROJECT_CONNECTOR_RUNTIME_CONTROL_FILE',
  'PROJECT_CONNECTOR_RUNTIME_DECISION_FILE',
  'PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID',
  'PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE',
  'PROJECT_CONNECTOR_RUNTIME_OUTCOME_FILE',
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

async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition did not become true.');
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

  test('persists pending maintenance before registration and dispatches after the session exists', async () => {
    const events: string[] = [];
    let decisionCalls = 0;
    const hub = await listeningServer({
      async authenticateConnectorCredential() {
        return { machineId: 'runtime-pending', userId: 'owner-576' };
      },
      async continueConnectorRuntimeMaintenance({ machineId, ownerUserId }) {
        expect(isConnectorCommandChannelAvailable(machineId)).toBe(true);
        expect(ownerUserId).toBe('owner-576');
        events.push('continue');
      },
      async decideConnectorRuntimeMaintenance() {
        decisionCalls += 1;
        return undefined;
      },
      async prepareConnectorRuntimeMaintenance({ machineId, ownerUserId }) {
        expect(isConnectorCommandChannelAvailable(machineId)).toBe(false);
        expect(ownerUserId).toBe('owner-576');
        events.push('prepare');
      }
    });
    const socket = new WebSocket(hub.origin.replace(/^http/, 'ws') + '/api/connectors/socket');
    await once(socket, 'open');
    socket.send(JSON.stringify({
      payload: registry('runtime-pending'),
      token: 'credential',
      type: 'connector.register'
    }));
    try {
      await once(socket, 'message');
      await waitFor(() => events.length === 2);
      expect(events).toEqual(['prepare', 'continue']);
      expect(decisionCalls).toBe(0);
    } finally {
      socket.close();
      hub.server.closeAllConnections();
      await hub.commands.close();
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
    }
  });

  test('persists an authenticated matching hub decision before becoming ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-runtime-bridge-'));
    const maintenance = join(root, '.project-space-machine-tools', 'maintenance');
    await mkdir(maintenance, { recursive: true });
    const decisionPath = join(maintenance, 'decision.json');
    const outcomePath = join(maintenance, 'outcome.json');
    const commandKeys = generateKeyPairSync('ed25519');
    const releaseKeys = generateKeyPairSync('ed25519');
    process.env.PROJECT_SPACE_INSTALL_SOURCE = 'managed';
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY = commandKeys.publicKey
      .export({ format: 'pem', type: 'spki' }).toString();
    process.env.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY = releaseKeys.publicKey
      .export({ format: 'pem', type: 'spki' }).toString();
    process.env.PROJECT_CONNECTOR_RUNTIME_CONTROL_FILE = join(maintenance, 'control.json');
    process.env.PROJECT_CONNECTOR_RUNTIME_DECISION_FILE = decisionPath;
    process.env.PROJECT_CONNECTOR_RUNTIME_OUTCOME_FILE = outcomePath;
    process.env.PROJECT_CONNECTOR_RUNTIME_STAGING_DIR = join(root, 'staging');
    let decisionCalls = 0;
    const hub = await listeningServer({
      async authenticateConnectorCredential() { return true; },
      async decideConnectorRuntimeMaintenance({ machine, registry: registered }) {
        decisionCalls += 1;
        expect(registered.connector.runtime?.buildId).toBe('1'.repeat(40));
        expect(machine.connector.runtime).toEqual(registered.connector.runtime);
        expect(machine.connector.capabilities).toEqual(registered.connector.capabilities);
        return { action: 'commit', operationId: 'operation-bridge' };
      }
    });
    process.env.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID = 'operation-bridge';
    process.env.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE = 'pending-health-check';
    const backend = {
      async getConnectorProjectRegistry() {
        const operationId = process.env.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID;
        const state = process.env.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE;
        return registry('ignored-by-runtime-binding', operationId &&
          (state === 'pending-health-check' || state === 'rolled-back')
          ? { operationId, state }
          : undefined);
      }
    } as ProjectSpaceBackend;
    const bridges: Array<ReturnType<typeof startProjectConnectorWebSocket>> = [];
    const selectionEvents: string[] = [];
    const startBridge = () => startProjectConnectorWebSocket({
      backend,
      reconnectDelayMs: 10,
      runtimeMaintenanceSelection: {
        async commit(operationId) {
          selectionEvents.push(`commit:${operationId}`);
        },
        async restore(operationId) {
          selectionEvents.push(`restore:${operationId}`);
        }
      },
      runtimeCredential: {
        backendUrl: hub.origin,
        credential: 'machine-credential',
        machineId: 'runtime-bridge',
        version: connectorRuntimeCredentialVersion
      }
    });
    bridges.push(startBridge());
    const supervisor = (async () => {
      await waitFor(() => Bun.file(decisionPath).exists());
      expect(selectionEvents).toEqual([]);
      await writeFile(outcomePath, `${JSON.stringify({
        action: 'commit',
        operationId: 'operation-bridge',
        schema: connectorRuntimeSupervisorOutcomeSchema
      })}\n`, { mode: 0o600 });
    })();
    try {
      await waitFor(async () => {
        try {
          return isConnectorRuntimeSupervisorDecision(
            JSON.parse(await readFile(decisionPath, 'utf8'))
          );
        } catch {
          return false;
        }
      });
      expect(JSON.parse(await readFile(decisionPath, 'utf8'))).toEqual({
        action: 'commit', operationId: 'operation-bridge',
        schema: connectorRuntimeSupervisorDecisionSchema
      });
      await supervisor;
      await waitFor(() => decisionCalls >= 2);
      expect(selectionEvents).toEqual(['commit:operation-bridge']);
      expect(process.env.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID).toBeUndefined();
      expect(process.env.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE).toBeUndefined();
      expect(isConnectorCommandChannelAvailable('runtime-bridge')).toBe(true);
      await rm(decisionPath);
      bridges.at(-1)!.close();
      await waitFor(() => !isConnectorCommandChannelAvailable('runtime-bridge'));
      for (let reconnect = 0; reconnect < 2; reconnect += 1) {
        bridges.push(startBridge());
        await waitFor(() => isConnectorCommandChannelAvailable('runtime-bridge'));
        expect(await Bun.file(decisionPath).exists()).toBe(false);
        expect(decisionCalls).toBe(2);
        bridges.at(-1)!.close();
        await waitFor(() => !isConnectorCommandChannelAvailable('runtime-bridge'));
      }
    } finally {
      bridges.forEach((bridge) => bridge.close());
      hub.server.closeAllConnections();
      await hub.commands.close();
      await new Promise<void>((resolve) => hub.server.close(() => resolve()));
      await rm(root, { force: true, recursive: true });
    }
  });
});
