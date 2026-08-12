import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { createConnectorCommandGrant } from '../server/connector-command-grant';
import type {
  ConnectorDevServerAdapter,
  ConnectorDevServerOperation,
  ConnectorDevServerTrustedRequest
} from '../server/connector-dev-server-contract';
import { ConnectorDevServerCommandExecutor } from '../server/connector-dev-server-executor';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';

const keys = generateKeyPairSync('ed25519');
const request: ConnectorDevServerTrustedRequest = {
  allowedHosts: ['project.example.test'],
  expectedHeadSha: 'a'.repeat(40),
  machineId: 'machine-dev-server',
  projectId: 'project-1',
  runTarget: 'web',
  serverId: 'web',
  worktreeId: 'wt_111111111111111111111111'
};

function signed(operation: Exclude<ConnectorDevServerOperation, 'list'>, nonce: string) {
  return {
    ...request,
    grant: createConnectorCommandGrant({
      actor: { generation: 4, userId: 'user-owner' }, operation, request
    }, keys.privateKey, { nonce: `nonce-${nonce}-0000000000000000`, now: Date.now() })
  };
}

function result(state: 'running' | 'stopped') {
  return {
    capability: 'configured' as const,
    checkedAt: new Date().toISOString(),
    generation: 4,
    machineId: request.machineId,
    projectId: request.projectId,
    runTarget: request.runTarget,
    serverId: request.serverId,
    state,
    worktreeId: request.worktreeId
  };
}

describe('connector dev-server maintenance admission', () => {
  test('maintenance rejects start and stop while inspect remains available', async () => {
    const calls: ConnectorDevServerOperation[] = [];
    const adapter: ConnectorDevServerAdapter = {
      async listDevServers() { throw new Error('not used'); },
      async runDevServerCommand(execution) {
        calls.push(execution.operation);
        return result('stopped');
      }
    };
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const maintenance = createConnectorRuntimeMaintenanceSafetyCheck(
      admission, { maintenanceBlockers: () => [] }
    )();
    const executor = new ConnectorDevServerCommandExecutor(
      adapter, keys.publicKey, request.machineId, admission
    );

    await expect(executor.execute('start', signed('start', 'dev-start-busy'))).resolves.toMatchObject({
      capability: 'unavailable',
      lastError: 'Connector runtime maintenance is in progress.',
      state: 'stopped'
    });
    await expect(executor.execute('stop', signed('stop', 'dev-stop-busy'))).resolves.toMatchObject({
      capability: 'unavailable',
      state: 'stopped'
    });
    await expect(executor.execute(
      'inspect', signed('inspect', 'dev-inspect-open')
    )).resolves.toMatchObject({ state: 'stopped' });
    expect(calls).toEqual(['inspect']);
    if (maintenance.certainty === 'known') maintenance.lease?.release();
  });

  test('start reserves activity before runtime maintenance checks', async () => {
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const adapter: ConnectorDevServerAdapter = {
      async listDevServers() { throw new Error('not used'); },
      async runDevServerCommand() {
        await barrier;
        return result('stopped');
      }
    };
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const executor = new ConnectorDevServerCommandExecutor(
      adapter, keys.publicKey, request.machineId, admission
    );
    const starting = executor.execute('start', signed('start', 'dev-start-race'));

    expect(createConnectorRuntimeMaintenanceSafetyCheck(
      admission, { maintenanceBlockers: () => [] }
    )()).toEqual({
      blockers: [{ count: 1, kind: 'connector-activity', scope: 'dev-server' }],
      certainty: 'known'
    });
    finish();
    await expect(starting).resolves.toMatchObject({ state: 'stopped' });
  });
});
