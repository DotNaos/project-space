import { generateKeyPairSync } from 'node:crypto';

import { expect, test } from 'bun:test';

import { createCodexSessionsWireRequest } from '../server/codex-sessions-connector-contract';
import type { ConnectorHubMessage } from '../server/connector-command-protocol';
import { CodexSessionsConnectorDispatcher } from '../server/codex-sessions/connector-dispatch';
import type { CodexSessionManager } from '../server/codex-sessions/manager';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';

const keys = generateKeyPairSync('ed25519');
const machineId = 'authorization-admission-machine';

function request(action: 'start' | 'status', operationId: string) {
  return createCodexSessionsWireRequest({
    generation: 7,
    operation: 'authorization',
    operationId,
    payload: { action, machineId, operationId },
    userId: 'user-owner'
  }, keys.privateKey, { nonce: `nonce-${operationId}` });
}

test('Codex authorization start shares maintenance admission while status stays open', async () => {
  const admission = new ConnectorRuntimeMaintenanceAdmission();
  const calls: string[] = [];
  let finishStart!: () => void;
  const startBarrier = new Promise<void>((resolve) => { finishStart = resolve; });
  const messages: ConnectorHubMessage[] = [];
  const dispatcher = new CodexSessionsConnectorDispatcher({
    authorization: {
      async close() {},
      async execute(input) {
        calls.push(input.action);
        if (input.action === 'start') await startBarrier;
        return { state: 'ready' };
      }
    },
    expectedMachineId: machineId,
    maintenanceAdmission: admission,
    manager: {} as CodexSessionManager,
    verificationKey: keys.publicKey
  });
  dispatcher.setExpectedGeneration(7);
  const inspect = createConnectorRuntimeMaintenanceSafetyCheck(admission, {
    maintenanceBlockers: () => []
  });
  const maintenance = inspect();
  expect(maintenance.certainty === 'known' && maintenance.lease).toBeDefined();

  dispatcher.dispatch('authorization-blocked', request('start', 'auth-blocked'),
    (message) => messages.push(message), () => { throw new Error('grant rejected'); });
  dispatcher.dispatch('authorization-status', request('status', 'auth-status'),
    (message) => messages.push(message), () => { throw new Error('grant rejected'); });
  await Bun.sleep(0);
  expect(calls).toEqual(['status']);
  expect(messages).toContainEqual(expect.objectContaining({
    id: 'authorization-blocked', type: 'codex.sessions.error'
  }));
  expect(messages).toContainEqual(expect.objectContaining({
    id: 'authorization-status', type: 'codex.sessions.result'
  }));
  if (maintenance.certainty === 'known') maintenance.lease?.release();

  dispatcher.dispatch('authorization-running', request('start', 'auth-running'),
    (message) => messages.push(message), () => { throw new Error('grant rejected'); });
  await Bun.sleep(0);
  expect(inspect()).toEqual({
    blockers: [{ count: 1, kind: 'connector-activity', scope: 'daemon' }],
    certainty: 'known'
  });
  finishStart();
  await Bun.sleep(0);
  const after = inspect();
  expect(after.certainty === 'known' && after.lease).toBeDefined();
  if (after.certainty === 'known') after.lease?.release();
  dispatcher.close();
});
