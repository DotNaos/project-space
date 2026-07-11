import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  ConnectorCommandGrantError,
  ConnectorCommandReplayProtection,
  connectorCommandGrantSigningKey,
  createConnectorCommandGrant,
  verifyConnectorCommandGrant
} from '../server/connector-command-grant';
import {
  isConnectorDevServerResult,
  isConnectorDevServerWireRequest,
  normalizeAllowedHosts,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerTrustedRequest
} from '../server/connector-dev-server-contract';
import { ConnectorDevServerCommandExecutor } from '../server/connector-dev-server-executor';

const now = Date.parse('2026-07-11T10:00:00.000Z');

afterEach(() => {
  delete process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64;
});
const baseRequest: ConnectorDevServerTrustedRequest = {
  allowedHosts: ['phone.tail.example', '100.80.135.9'],
  machineId: 'test-machine',
  projectId: 'test-machine:project-space',
  runTarget: 'dev',
  worktreeId: '/tmp/project-space-worktree',
  worktreePath: '/tmp/project-space-worktree'
};

function commandGrant(
  generation = 3,
  nonce = 'grant-nonce-0000000000000001',
  issuedAt = now
) {
  const keys = generateKeyPairSync('ed25519');
  const request = {
    ...baseRequest,
    allowedHosts: normalizeAllowedHosts(baseRequest.allowedHosts)
  };
  const grant = createConnectorCommandGrant(
    {
      actor: { generation, userId: 'user_123' },
      operation: 'start',
      request
    },
    keys.privateKey,
    { nonce, now: issuedAt, ttlMs: 30_000 }
  );
  return { grant, keys, request };
}

function errorCode(callback: () => unknown) {
  try {
    callback();
    return undefined;
  } catch (error) {
    return error instanceof ConnectorCommandGrantError ? error.code : 'unexpected';
  }
}

describe('connector command grants', () => {
  test('loads a base64-encoded PKCS8 signing key for dotenv-safe deployment', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64 = Buffer.from(pem).toString(
      'base64'
    );

    expect(connectorCommandGrantSigningKey()).toBe(pem.trim());
  });

  test('binds actor, target, operation, allowed hosts, expiry, and generation', () => {
    const { grant, keys, request } = commandGrant();
    const actor = verifyConnectorCommandGrant(
      grant,
      request,
      'start',
      keys.publicKey,
      { expectedUserId: 'user_123', now: now + 1_000 }
    );

    expect(actor).toEqual({ generation: 3, userId: 'user_123' });
    expect(
      isConnectorDevServerWireRequest({ ...request, grant })
    ).toBe(true);
    expect(
      isConnectorDevServerWireRequest({ ...request, grant, unexpected: true })
    ).toBe(false);
    expect(
      isConnectorDevServerResult({
        capability: 'configured',
        checkedAt: '2026-07-11T02:01:02.276654Z',
        generation: 3,
        machineId: request.machineId,
        projectId: request.projectId,
        runTarget: request.runTarget,
        state: 'stopped',
        worktreeId: request.worktreeId
      })
    ).toBe(true);
  });

  test('rejects tampering and mismatched user, machine, worktree, operation, and hosts', () => {
    const { grant, keys, request } = commandGrant();
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          { ...grant, userId: 'user_attacker' },
          request,
          'start',
          keys.publicKey,
          { now }
        )
      )
    ).toBe('invalid-signature');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(grant, request, 'start', keys.publicKey, {
          expectedUserId: 'user_other',
          now
        })
      )
    ).toBe('binding-mismatch');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          grant,
          { ...request, machineId: 'other-machine' },
          'start',
          keys.publicKey,
          { now }
        )
      )
    ).toBe('binding-mismatch');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          grant,
          { ...request, worktreeId: '/tmp/other-worktree' },
          'start',
          keys.publicKey,
          { now }
        )
      )
    ).toBe('binding-mismatch');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(grant, request, 'stop', keys.publicKey, { now })
      )
    ).toBe('binding-mismatch');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          grant,
          { ...request, allowedHosts: ['other.example'] },
          'start',
          keys.publicKey,
          { now }
        )
      )
    ).toBe('binding-mismatch');
  });

  test('rejects expired, replayed, and stale-generation grants', () => {
    const replayProtection = new ConnectorCommandReplayProtection();
    const first = commandGrant(2, 'grant-nonce-generation-two-0002');
    verifyConnectorCommandGrant(
      first.grant,
      first.request,
      'start',
      first.keys.publicKey,
      { now, replayProtection }
    );
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          first.grant,
          first.request,
          'start',
          first.keys.publicKey,
          { now, replayProtection }
        )
      )
    ).toBe('replayed');

    const staleGrant = createConnectorCommandGrant(
      {
        actor: { generation: 1, userId: 'user_123' },
        operation: 'start',
        request: first.request
      },
      first.keys.privateKey,
      { nonce: 'grant-nonce-generation-one-0001', now, ttlMs: 30_000 }
    );
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          staleGrant,
          first.request,
          'start',
          first.keys.publicKey,
          { now, replayProtection }
        )
      )
    ).toBe('stale-generation');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          first.grant,
          first.request,
          'start',
          first.keys.publicKey,
          { now: now + 40_000 }
        )
      )
    ).toBe('expired');
  });

  test('passes verified actor identity to the adapter and blocks replay before execution', async () => {
    const { grant, keys, request } = commandGrant(
      3,
      'grant-nonce-executor-0000000003',
      Date.now()
    );
    const executions: Array<{ generation: number; userId: string }> = [];
    const adapter: ConnectorDevServerAdapter = {
      async runDevServerCommand(execution) {
        executions.push(execution.actor);
        return {
          capability: 'configured',
          checkedAt: '2026-07-11T10:00:01.000Z',
          generation: execution.actor.generation,
          localPort: 5173,
          localUrl: 'http://127.0.0.1:5173',
          machineId: execution.machineId,
          projectId: execution.projectId,
          publicPort: 45173,
          runTarget: execution.runTarget,
          startedAt: '2026-07-11T10:00:00.000Z',
          state: 'running',
          tailscaleIPv4: '100.80.135.9',
          tailscaleUrl: 'http://100.80.135.9:45173',
          worktreeId: execution.worktreeId
        };
      }
    };
    const executor = new ConnectorDevServerCommandExecutor(adapter, keys.publicKey);
    const wireRequest = { ...request, grant };

    const result = await executor.execute('start', wireRequest);
    const replayed = await executor.execute('start', wireRequest);

    expect(result.state).toBe('running');
    expect(executions).toEqual([{ generation: 3, userId: 'user_123' }]);
    expect(replayed).toMatchObject({
      lastError: 'Connector command authorization failed.',
      state: 'error'
    });
  });
});
