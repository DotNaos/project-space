import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  registerConnectorSession,
  removeConnectorSession
} from '../server/connector-command-session-registry';
import {
  isConnectorHubMessage,
  isConnectorMachineMessage
} from '../server/connector-command-protocol';
import { drainConnectorWebSocket } from '../server/project-connector-websocket-utils';
import {
  connectorRuntimeStopBinding,
  connectorRuntimeStopSchema,
  createConnectorRuntimeStopWireRequest,
  type ConnectorRuntimeStopIdentity,
  type ConnectorRuntimeStopPlan
} from '../server/connector-runtime-stop-contract';
import {
  ConnectorRuntimeStopDispatcher,
  handleConnectorRuntimeStopMessage,
  isConnectorRuntimeStopMachineMessage,
  requestConnectorRuntimeStop,
  type ConnectorRuntimeStopHubMessage
} from '../server/connector-runtime-stop-routing';

const keys = generateKeyPairSync('ed25519');
const now = Date.parse('2026-07-15T00:00:00.000Z');
const machineId = 'machine-source-dev';
const runtime: ConnectorRuntimeStopIdentity = {
  buildId: 'b'.repeat(40),
  channel: 'dev',
  instanceId: 'instance-current',
  protocolVersion: '2',
  releaseId: `dev-source-${'b'.repeat(40)}`,
  source: 'source'
};

function plan(): ConnectorRuntimeStopPlan {
  return {
    expectedRuntime: runtime,
    machineId,
    operation: 'stop',
    operationId: 'operation-stop',
    schema: connectorRuntimeStopSchema,
    target: 'linux-x64'
  };
}

afterEach(() => {
  removeConnectorSession(machineId);
});

describe('connector runtime stop routing', () => {
  test('routes through the authenticated generation and resolves only the exact binding', async () => {
    const sent: string[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send(value: string) {
        sent.push(value);
      }
    } as unknown as WebSocket;
    const generation = registerConnectorSession(
      machineId,
      socket,
      'credential-source-dev',
      ['runtime.stop']
    );
    const pending = requestConnectorRuntimeStop(plan(), 'user-owner', {
      nonce: 'nonce-routing',
      now,
      signingKey: keys.privateKey,
      timeoutMs: 1_000
    });
    expect(sent).toHaveLength(1);
    const message: unknown = JSON.parse(sent[0]!);
    expect(isConnectorRuntimeStopMachineMessage(message)).toBe(true);
    expect(isConnectorMachineMessage(message)).toBe(true);
    if (!isConnectorRuntimeStopMachineMessage(message)) throw new Error('Expected stop message.');
    expect(message.payload.grant.generation).toBe(generation);

    const result: ConnectorRuntimeStopHubMessage = {
      id: message.id,
      payload: {
        binding: connectorRuntimeStopBinding(message.payload),
        status: 'accepted'
      },
      type: 'runtime.stop.result'
    };
    expect(isConnectorHubMessage(result)).toBe(true);
    expect(handleConnectorRuntimeStopMessage(machineId, result)).toBe(true);
    await expect(pending).resolves.toEqual(result.payload);
  });

  test('fails closed when the acknowledgement comes from another machine', async () => {
    const sent: string[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send(value: string) {
        sent.push(value);
      }
    } as unknown as WebSocket;
    registerConnectorSession(machineId, socket, 'credential-source-dev', ['runtime.stop']);
    const pending = requestConnectorRuntimeStop(plan(), 'user-owner', {
      nonce: 'nonce-wrong-machine',
      now,
      signingKey: keys.privateKey,
      timeoutMs: 1_000
    });
    const message: unknown = JSON.parse(sent[0]!);
    if (!isConnectorRuntimeStopMachineMessage(message)) throw new Error('Expected stop message.');
    handleConnectorRuntimeStopMessage('machine-attacker', {
      id: message.id,
      payload: { binding: connectorRuntimeStopBinding(message.payload), status: 'accepted' },
      type: 'runtime.stop.result'
    });
    await expect(pending).rejects.toBeInstanceOf(Error);
  });

  test('sends the accepted acknowledgement before self-termination', async () => {
    const request = createConnectorRuntimeStopWireRequest(
      { generation: 7, plan: plan(), userId: 'user-owner' },
      keys.privateKey,
      { nonce: 'nonce-dispatch', now }
    );
    const events: string[] = [];
    const dispatcher = new ConnectorRuntimeStopDispatcher({
      commandVerificationKey: keys.publicKey,
      expectedMachineId: machineId,
      expectedRuntime: runtime,
      expectedTarget: 'linux-x64',
      now: () => now,
      shutdown() {
        events.push('shutdown');
      }
    });
    dispatcher.setExpectedGeneration(7);
    await dispatcher.dispatch(
      'message-stop',
      request,
      async (message) => {
        expect(message.type).toBe('runtime.stop.result');
        events.push('ack-start');
        await Promise.resolve();
        events.push('ack-complete');
      },
      () => events.push('rejected')
    );
    expect(events).toEqual(['ack-start', 'ack-complete', 'shutdown']);
  });

  test('never acknowledges or shuts down a stale process binding', async () => {
    const request = createConnectorRuntimeStopWireRequest(
      { generation: 7, plan: plan(), userId: 'user-owner' },
      keys.privateKey,
      { nonce: 'nonce-stale', now }
    );
    const events: string[] = [];
    const dispatcher = new ConnectorRuntimeStopDispatcher({
      commandVerificationKey: keys.publicKey,
      expectedMachineId: machineId,
      expectedRuntime: { ...runtime, instanceId: 'instance-restarted' },
      expectedTarget: 'linux-x64',
      now: () => now,
      shutdown: () => events.push('shutdown')
    });
    dispatcher.setExpectedGeneration(7);
    await dispatcher.dispatch(
      'message-stale',
      request,
      () => events.push('ack'),
      () => events.push('rejected')
    );
    expect(events).toEqual(['rejected']);
  });

  test('bounds WebSocket queue draining for the later shutdown bridge', async () => {
    let bufferedAmount = 1;
    const draining = {
      get bufferedAmount() { return bufferedAmount; },
      readyState: WebSocket.OPEN
    } as WebSocket;
    setTimeout(() => { bufferedAmount = 0; }, 5);
    await expect(drainConnectorWebSocket(draining, {
      pollIntervalMs: 1,
      timeoutMs: 50
    })).resolves.toBe(true);

    const blocked = {
      bufferedAmount: 1,
      readyState: WebSocket.OPEN
    } as WebSocket;
    await expect(drainConnectorWebSocket(blocked, {
      pollIntervalMs: 1,
      timeoutMs: 3
    })).resolves.toBe(false);
  });
});
