import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { WebSocket } from 'ws';

import {
  CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY,
  createCodexSessionsWireRequest
} from '../server/codex-sessions-connector-contract';
import {
  isConnectorHubMessage,
  isConnectorMachineMessage,
  type ConnectorHubMessage,
  type ConnectorMachineMessage
} from '../server/connector-command-protocol';
import {
  registerConnectorSession,
  removeConnectorSession
} from '../server/connector-command-session-registry';
import type {
  ConnectorCodexAttachRelay,
  ConnectorCodexAttachRelayCloseCode
} from '../server/codex-machine-tasks/connector-attach-relay';
import { CodexSessionsConnectorDispatcher } from '../server/codex-sessions/connector-dispatch';
import {
  CodexAttachChunkAssembler,
  bindingForCodexSessionsRequest,
  codexAttachMessageChunks
} from '../server/codex-sessions/connector-channel';
import {
  handleCodexSessionsConnectorMessage,
  openConnectorCodexAttach
} from '../server/codex-sessions/connector-hub';
import type { CodexSessionManager } from '../server/codex-sessions/manager';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';

const keys = generateKeyPairSync('ed25519');
const machineId = 'attach-machine';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';

describe('Codex remote attach connector tunnel', () => {
  test('shares maintenance admission for raw follow-ups while reads and interrupt stay open', async () => {
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    let invalidations = 0;
    let finishReconciliation!: () => void;
    const reconciliation = new Promise<void>((resolve) => { finishReconciliation = resolve; });
    const manager = {
      invalidateMaintenanceState() { invalidations += 1; },
      reconcileMaintenanceState() { return reconciliation; }
    } as CodexSessionManager;
    let relayOptions: Parameters<NonNullable<
      ConstructorParameters<typeof CodexSessionsConnectorDispatcher>[0]['createAttachRelay']
    >>[0] | undefined;
    const relayInput: string[] = [];
    const sent: ConnectorHubMessage[] = [];
    const dispatcher = new CodexSessionsConnectorDispatcher({
      createAttachRelay: async (options) => {
        relayOptions = options;
        return { close() {}, async send(message) { relayInput.push(message); } };
      },
      expectedMachineId: machineId,
      maintenanceAdmission: admission,
      manager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(5);
    const request = createCodexSessionsWireRequest({
      generation: 5,
      operation: 'attach',
      operationId: 'attach-maintenance',
      payload: {
        machineId, operationId: 'attach-maintenance', threadId,
        tunnelId: 'tunnel-maintenance'
      },
      userId: 'user-owner'
    }, keys.privateKey);
    dispatcher.dispatch('tunnel-maintenance', request, (message) => sent.push(message), () => {
      throw new Error('attach grant rejected');
    });
    await Bun.sleep(0);
    const binding = bindingForCodexSessionsRequest(request);
    let inputMessageId = 1;
    const sendInput = (message: string) => {
      for (const chunk of codexAttachMessageChunks(message, inputMessageId++)) {
        expect(dispatcher.acceptAttachInput('tunnel-maintenance', { binding, chunk })).toBe(true);
      }
    };
    const inspect = createConnectorRuntimeMaintenanceSafetyCheck(admission, {
      maintenanceBlockers: () => []
    });

    const maintenance = inspect();
    expect(maintenance.certainty === 'known' && maintenance.lease).toBeDefined();
    sendInput(JSON.stringify({ id: 1, method: 'thread/read', params: { threadId } }));
    sendInput(JSON.stringify({ id: 2, method: 'turn/interrupt', params: { threadId } }));
    sendInput(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId } }));
    await Bun.sleep(0);
    expect(relayInput.map((message) => JSON.parse(message).method)).toEqual([
      'thread/read', 'turn/interrupt'
    ]);
    const rejected = new CodexAttachChunkAssembler();
    let rejectedMessage: string | undefined;
    for (const message of sent) {
      if (message.type === 'codex.attach.output') {
        rejectedMessage = rejected.push(message.payload.chunk) ?? rejectedMessage;
      }
    }
    expect(JSON.parse(rejectedMessage ?? '{}')).toMatchObject({
      error: { code: -32_000 }, id: 3
    });
    if (maintenance.certainty === 'known') maintenance.lease?.release();

    sendInput(JSON.stringify({ id: 4, method: 'turn/start', params: { threadId } }));
    await Bun.sleep(0);
    expect(invalidations).toBe(1);
    expect(inspect()).toEqual({
      blockers: [{ count: 1, kind: 'connector-activity', scope: 'codex' }],
      certainty: 'known'
    });
    relayOptions?.onMessage(JSON.stringify({ id: 4, result: { turn: { id: 'turn-four' } } }));
    expect(inspect()).toEqual({
      blockers: [{ count: 1, kind: 'connector-activity', scope: 'codex' }],
      certainty: 'known'
    });
    finishReconciliation();
    await Bun.sleep(0);
    const after = inspect();
    expect(after.certainty === 'known' && after.lease).toBeDefined();
    if (after.certainty === 'known') after.lease?.release();
    dispatcher.close();
  });

  test('round-trips signed, generation-bound, chunked App Server messages', async () => {
    const outbound: ConnectorMachineMessage[] = [];
    const socket = {
      bufferedAmount: 0,
      readyState: WebSocket.OPEN,
      send(value: string) { outbound.push(JSON.parse(value)); }
    } as unknown as WebSocket;
    const generation = registerConnectorSession(
      machineId,
      socket,
      'connector-credential',
      [CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY]
    );
    let relayOptions: Parameters<NonNullable<ConstructorParameters<typeof CodexSessionsConnectorDispatcher>[0]['createAttachRelay']>>[0] | undefined;
    const relayInput: string[] = [];
    const relay: ConnectorCodexAttachRelay = {
      close() {},
      async send(message) { relayInput.push(message); }
    };
    const dispatcher = new CodexSessionsConnectorDispatcher({
      createAttachRelay: async (options) => {
        relayOptions = options;
        return relay;
      },
      expectedMachineId: machineId,
      manager: {} as CodexSessionManager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(generation);
    const received: string[] = [];
    const closed: string[] = [];
    try {
      const opening = openConnectorCodexAttach({
        machineId,
        operationId: 'attach-operation-one',
        threadId
      }, {
        generation,
        onClose: (code) => closed.push(code),
        onMessage: (message) => received.push(message),
        signingKey: keys.privateKey,
        userId: 'user-owner'
      });
      const openMessage = outbound.shift();
      expect(openMessage?.type).toBe('codex.sessions.command');
      expect(isConnectorMachineMessage(openMessage)).toBe(true);
      if (!openMessage || openMessage.type !== 'codex.sessions.command') throw new Error('missing open');
      expect(openMessage.id).toBe((openMessage.payload.payload as { tunnelId: string }).tunnelId);
      const connectorMessages: ConnectorHubMessage[] = [];
      dispatcher.dispatch(
        openMessage.id,
        openMessage.payload,
        (message) => connectorMessages.push(message),
        () => { throw new Error('attach grant rejected'); }
      );
      await Bun.sleep(0);
      for (const message of connectorMessages.splice(0)) {
        expect(isConnectorHubMessage(message)).toBe(true);
        handleCodexSessionsConnectorMessage(machineId, message);
      }
      const tunnel = await opening;

      const clientMessage = JSON.stringify({
        id: 1,
        method: 'thread/read',
        params: { padding: 'x'.repeat(300_000), threadId }
      });
      tunnel.send(clientMessage);
      expect(outbound.length).toBeGreaterThan(1);
      for (const message of outbound.splice(0)) {
        expect(message.type).toBe('codex.attach.input');
        expect(isConnectorMachineMessage(message)).toBe(true);
        if (message.type === 'codex.attach.input') {
          expect(dispatcher.acceptAttachInput(message.id, message.payload)).toBe(true);
        }
      }
      await Bun.sleep(0);
      expect(relayInput).toEqual([clientMessage]);

      const serverMessage = JSON.stringify({
        id: 1,
        result: { padding: 'y'.repeat(300_000), thread: { id: threadId } }
      });
      relayOptions?.onMessage(serverMessage);
      expect(connectorMessages.length).toBeGreaterThan(1);
      for (const message of connectorMessages.splice(0)) {
        expect(isConnectorHubMessage(message)).toBe(true);
        handleCodexSessionsConnectorMessage(machineId, message);
      }
      expect(received).toEqual([serverMessage]);
      tunnel.close();
      expect(outbound.at(-1)).toMatchObject({ type: 'connector.command.cancel' });
      expect(closed).toEqual([]);
    } finally {
      dispatcher.close();
      removeConnectorSession(machineId, socket);
    }
  });

  test('rejects stale or tampered attach grants and invalid chunk ordering', async () => {
    const dispatcher = new CodexSessionsConnectorDispatcher({
      createAttachRelay: async () => ({ close() {}, async send() {} }),
      expectedMachineId: machineId,
      manager: {} as CodexSessionManager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(8);
    const request = createCodexSessionsWireRequest({
      generation: 7,
      operation: 'attach',
      operationId: 'attach-stale',
      payload: { machineId, operationId: 'attach-stale', threadId, tunnelId: 'tunnel-stale' },
      userId: 'user-owner'
    }, keys.privateKey);
    let rejected = false;
    dispatcher.dispatch('tunnel-stale', request, () => {}, () => { rejected = true; });
    expect(rejected).toBe(true);

    const binding = bindingForCodexSessionsRequest(request);
    const chunks = codexAttachMessageChunks('{"id":1}', 1);
    const assembler = new CodexAttachChunkAssembler();
    expect(() => assembler.push({ ...chunks[0]!, chunkIndex: 1 })).toThrow();
    expect(isConnectorMachineMessage({
      id: 'tunnel-stale',
      payload: { binding, chunk: { ...chunks[0], data: 'not-base64' } },
      type: 'codex.attach.input'
    })).toBe(false);
    dispatcher.close();
  });

  test('reports connector process closure without leaking diagnostics', async () => {
    const sent: ConnectorHubMessage[] = [];
    let relayOptions: {
      onClose(code: ConnectorCodexAttachRelayCloseCode): void;
      onMessage(message: string): void;
    } | undefined;
    const dispatcher = new CodexSessionsConnectorDispatcher({
      createAttachRelay: async (options) => {
        relayOptions = options;
        return { close() {}, async send() {} };
      },
      expectedMachineId: machineId,
      manager: {} as CodexSessionManager,
      verificationKey: keys.publicKey
    });
    dispatcher.setExpectedGeneration(3);
    const request = createCodexSessionsWireRequest({
      generation: 3,
      operation: 'attach',
      operationId: 'attach-close',
      payload: { machineId, operationId: 'attach-close', threadId, tunnelId: 'tunnel-close' },
      userId: 'user-owner'
    }, keys.privateKey);
    dispatcher.dispatch('tunnel-close', request, (message) => sent.push(message), () => {});
    await Bun.sleep(0);
    relayOptions?.onClose('process_exited');
    expect(sent.at(-1)).toEqual({
      id: 'tunnel-close',
      payload: { binding: bindingForCodexSessionsRequest(request), code: 'process_exited' },
      type: 'codex.attach.closed'
    });
    expect(JSON.stringify(sent)).not.toContain('path');
    dispatcher.close();
  });
});
