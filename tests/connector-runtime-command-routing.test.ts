import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  createConnectorCommandUpgradeHandler,
  requestConnectorRuntimeMaintenance
} from '../server/connector-command-hub';
import {
  isConnectorMachineMessage,
  type ConnectorMachineMessage
} from '../server/connector-command-protocol';
import {
  createConnectorRuntimeCommandWireRequest,
  type ConnectorRuntimeRestartPlan
} from '../server/connector-runtime-command-contract';
import {
  ConnectorRuntimeCommandDispatcher,
  ConnectorRuntimeCommandOutcomeUnknownError,
  connectorRegistryForRuntimeConfiguration,
  connectorRuntimeCommandBinding,
  isConnectorRuntimeCommandResult,
  requestConnectorRuntimeCommand
} from '../server/connector-runtime-command-routing';
import type { ConnectorRuntimeReleaseTarget } from '../server/connector-runtime-maintenance-contract';
import { connectorRuntimeSupervisorOutcomeSchema } from '../server/connector-runtime-supervisor-outcome';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

const originalSigningKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;

afterEach(() => {
  if (originalSigningKey === undefined) {
    delete process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY;
  } else {
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY = originalSigningKey;
  }
});

function target(): ConnectorRuntimeReleaseTarget {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  return 'linux-x64';
}

function registration(machineId: string, capabilities = ['runtime.restart']) {
  const payload: ConnectorProjectRegistryResult = {
    checkedAt: '2026-07-14T00:00:00.000Z',
    connector: {
      capabilities,
      machineId,
      machineName: machineId,
      runtime: {
        architecture: target().endsWith('arm64') ? 'arm64' : 'x64',
        buildId: 'a'.repeat(40),
        bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
        channel: 'stable',
        instanceId: 'stable-instance',
        lastCheckedAt: '2026-07-14T00:00:00.000Z',
        platform: target().startsWith('darwin') ? 'darwin' :
          target().startsWith('windows') ? 'windows' : 'linux',
        protocolVersion: '2',
        releaseId: 'v1.0.0',
        source: 'managed',
        version: '1.0.0'
      }
    },
    discovery: {
      groups: [], projects: [], rootItems: [], rootPath: '/tmp', structureViolations: []
    }
  };
  return JSON.stringify({ payload, token: 'credential', type: 'connector.register' });
}

function restartPlan(machineId: string, operationId: string): ConnectorRuntimeRestartPlan {
  return {
    machineId,
    operation: 'restart',
    operationId,
    previousRuntime: {
      buildId: 'a'.repeat(40),
      bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
      capabilities: ['runtime.restart'],
      instanceId: 'stable-instance',
      protocolVersion: '2',
      releaseId: 'v1.0.0',
      version: '1.0.0'
    },
    schema: 'project-space.connector-runtime-command/v1',
    target: target()
  };
}

async function openConnector(machineId: string, capabilities?: string[]) {
  const commands = createConnectorCommandUpgradeHandler({
    async authenticateConnectorCredential() { return true; }
  });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    if (!commands.handleUpgrade(request, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not expose a port.');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/connectors/socket`);
  await once(socket, 'open');
  socket.send(registration(machineId, capabilities));
  const [registeredRaw] = await once(socket, 'message') as [Buffer];
  const registered = JSON.parse(registeredRaw.toString()) as ConnectorMachineMessage;
  if (!isConnectorMachineMessage(registered) || registered.type !== 'connector.registered') {
    throw new Error('Connector registration failed.');
  }
  return { commands, generation: registered.generation, server, socket };
}

async function closeConnector(
  opened: Awaited<ReturnType<typeof openConnector>>
) {
  opened.socket.close();
  opened.server.closeAllConnections();
  await opened.commands.close();
  await new Promise<void>((resolve) => opened.server.close(() => resolve()));
}

describe('connector runtime command routing', () => {
  test('commits Codex only after the supervisor durably accepts the Hub decision', async () => {
    const keys = generateKeyPairSync('ed25519');
    const root = mkdtempSync(join(tmpdir(), 'runtime-decision-codex-'));
    const decisionPath = join(root, 'decision.json');
    const outcomePath = join(root, 'outcome.json');
    const events: string[] = [];
    try {
      const dispatcher = new ConnectorRuntimeCommandDispatcher({
        commandVerificationKey: keys.publicKey,
        controlFilePath: join(root, 'control.json'),
        decisionFilePath: decisionPath,
        expectedMachineId: 'runtime-decision',
        expectedTarget: target(),
        maintenanceSafety: () => ({ blockers: [], certainty: 'safe' }),
        maintenanceSelection: {
          async commit(operationId) {
            expect(existsSync(outcomePath)).toBe(true);
            events.push(`commit:${operationId}`);
          },
          async restore(operationId) {
            expect(existsSync(decisionPath)).toBe(false);
            events.push(`restore:${operationId}`);
          }
        },
        outcomeFilePath: outcomePath,
        outcomePollIntervalMs: 1,
        outcomeTimeoutMs: 1_000,
        releaseVerificationKey: keys.publicKey,
        shutdown() {},
        stagingDirectory: join(root, 'staging')
      });
      const evidence = {
        operationId: 'operation-codex-decision',
        state: 'pending-health-check' as const
      };

      await dispatcher.acceptRegistration(evidence, {
        action: 'rollback', operationId: evidence.operationId
      });
      expect(events).toEqual(['restore:operation-codex-decision']);
      expect(JSON.parse(readFileSync(decisionPath, 'utf8'))).toMatchObject({
        action: 'rollback', operationId: evidence.operationId
      });

      rmSync(decisionPath);
      const committing = dispatcher.acceptRegistration(evidence, {
        action: 'commit', operationId: evidence.operationId
      });
      for (let attempt = 0; attempt < 100 && !existsSync(decisionPath); attempt += 1) {
        await Bun.sleep(1);
      }
      expect(existsSync(decisionPath)).toBe(true);
      expect(events).toEqual(['restore:operation-codex-decision']);
      writeFileSync(outcomePath, `${JSON.stringify({
        action: 'commit',
        operationId: evidence.operationId,
        schema: connectorRuntimeSupervisorOutcomeSchema
      })}\n`, { mode: 0o600 });
      await committing;
      expect(events).toEqual([
        'restore:operation-codex-decision',
        'commit:operation-codex-decision'
      ]);
      expect(JSON.parse(readFileSync(decisionPath, 'utf8'))).toMatchObject({
        action: 'commit', operationId: evidence.operationId
      });
      expect(existsSync(outcomePath)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('does not commit Codex when the supervisor exits or times out without an outcome', async () => {
    const keys = generateKeyPairSync('ed25519');
    const root = mkdtempSync(join(tmpdir(), 'runtime-decision-timeout-'));
    const decisionPath = join(root, 'decision.json');
    let committed = false;
    try {
      const dispatcher = new ConnectorRuntimeCommandDispatcher({
        commandVerificationKey: keys.publicKey,
        controlFilePath: join(root, 'control.json'),
        decisionFilePath: decisionPath,
        expectedMachineId: 'runtime-decision-timeout',
        expectedTarget: target(),
        maintenanceSafety: () => ({ blockers: [], certainty: 'safe' }),
        maintenanceSelection: {
          async commit() { committed = true; },
          async restore() {}
        },
        outcomeFilePath: join(root, 'outcome.json'),
        outcomePollIntervalMs: 1,
        outcomeTimeoutMs: 10,
        releaseVerificationKey: keys.publicKey,
        shutdown() {},
        stagingDirectory: join(root, 'staging')
      });
      const evidence = {
        operationId: 'operation-codex-timeout',
        state: 'pending-health-check' as const
      };

      await expect(dispatcher.acceptRegistration(evidence, {
        action: 'commit', operationId: evidence.operationId
      })).rejects.toThrow('did not durably accept');
      expect(existsSync(decisionPath)).toBe(true);
      expect(committed).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('returns a typed busy rejection when connector safety is uncertain', async () => {
    const keys = generateKeyPairSync('ed25519');
    const root = mkdtempSync(join(tmpdir(), 'runtime-dispatch-safety-'));
    const messages: unknown[] = [];
    let authorizationRejected = false;
    let shutdown = false;
    const issuedAt = Date.parse('2026-08-10T12:00:00.000Z');
    try {
      const dispatcher = new ConnectorRuntimeCommandDispatcher({
        commandVerificationKey: keys.publicKey,
        controlFilePath: join(root, 'control', 'request.json'),
        decisionFilePath: join(root, 'decision.json'),
        expectedMachineId: 'runtime-busy',
        expectedTarget: target(),
        maintenanceSafety: () => ({ certainty: 'uncertain' }),
        now: () => issuedAt,
        releaseVerificationKey: keys.publicKey,
        shutdown() { shutdown = true; },
        shutdownDelayMs: 0,
        stagingDirectory: join(root, 'staging')
      });
      dispatcher.setExpectedGeneration(7);
      const request = createConnectorRuntimeCommandWireRequest({
        generation: 7,
        plan: restartPlan('runtime-busy', 'operation-busy'),
        userId: 'user_test'
      }, keys.privateKey, { nonce: 'runtime-busy-command-nonce', now: issuedAt });
      dispatcher.dispatch(
        'runtime-busy-request', request, (message) => messages.push(message),
        () => { authorizationRejected = true; }
      );
      await Bun.sleep(0);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: 'runtime-busy-request',
        payload: { code: 'codex-state-uncertain', status: 'rejected' },
        type: 'runtime.maintenance.result'
      });
      expect(isConnectorRuntimeCommandResult(
        (messages[0] as { payload: unknown }).payload
      )).toBe(true);
      expect(authorizationRejected).toBe(false);
      expect(existsSync(join(root, 'control', 'request.json'))).toBe(false);
      expect(shutdown).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('advertises managed maintenance or source stop without mixing capabilities', () => {
    const registry = JSON.parse(registration('runtime-capabilities', [
      'runtime.restart', 'runtime.stop', 'runtime.update', 'worktrees.list'
    ])).payload as ConnectorProjectRegistryResult;
    expect(connectorRegistryForRuntimeConfiguration(registry, true).connector.capabilities)
      .toEqual(['runtime.restart', 'runtime.update', 'worktrees.list']);
    expect(connectorRegistryForRuntimeConfiguration(
      registry,
      ['runtime.stop']
    ).connector.capabilities).toEqual(['runtime.stop', 'worktrees.list']);
    expect(connectorRegistryForRuntimeConfiguration(registry, false).connector.capabilities)
      .toEqual(['worktrees.list']);
  });

  test('relays a signed generation-bound operation with bounded progress', async () => {
    const keys = generateKeyPairSync('ed25519');
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY = keys.privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString();
    const opened = await openConnector('runtime-routing');
    const incoming = once(opened.socket, 'message');
    const stages: string[] = [];
    const result = requestConnectorRuntimeMaintenance({
      onProgress(stage) { stages.push(stage); },
      plan: restartPlan('runtime-routing', 'operation-routing'),
      userId: 'user_test'
    });
    try {
      const [raw] = await incoming as [Buffer];
      const message = JSON.parse(raw.toString());
      expect(isConnectorMachineMessage(message)).toBe(true);
      expect(message.type).toBe('runtime.maintenance');
      expect(message.payload.grant).toMatchObject({
        generation: opened.generation,
        machineId: 'runtime-routing',
        operation: 'restart',
        operationId: 'operation-routing',
        userId: 'user_test'
      });
      const binding = connectorRuntimeCommandBinding(message.payload);
      opened.socket.send(JSON.stringify({
        id: message.id,
        payload: { binding, stage: 'verifying' },
        type: 'runtime.maintenance.progress'
      }));
      opened.socket.send(JSON.stringify({
        id: message.id,
        payload: { binding, status: 'accepted' },
        type: 'runtime.maintenance.result'
      }));
      await result;
      expect(stages).toEqual(['verifying']);
    } finally {
      await closeConnector(opened);
    }
  });

  test('fails an in-flight operation when the authenticated connector disconnects', async () => {
    const keys = generateKeyPairSync('ed25519');
    const opened = await openConnector('runtime-interrupted');
    const incoming = once(opened.socket, 'message');
    const result = requestConnectorRuntimeCommand(
      restartPlan('runtime-interrupted', 'operation-interrupted'),
      'user_test',
      { signingKey: keys.privateKey, timeoutMs: 1_000 }
    );
    await incoming;
    opened.socket.close();
    try {
      await expect(result).rejects.toBeInstanceOf(ConnectorRuntimeCommandOutcomeUnknownError);
    } finally {
      await closeConnector(opened);
    }
  });

  test('does not send maintenance to a connector without the named capability', async () => {
    const opened = await openConnector('runtime-unsupported', []);
    try {
      expect(() => requestConnectorRuntimeCommand(
        restartPlan('runtime-unsupported', 'operation-unsupported'), 'user_test',
        { signingKey: generateKeyPairSync('ed25519').privateKey }
      )).toThrow('does not provide managed runtime maintenance');
    } finally {
      await closeConnector(opened);
    }
  });
});
