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
  isConnectorDevServerListResult,
  isConnectorDevServerResult,
  isConnectorDevServerListWireRequest,
  isConnectorDevServerWireRequest,
  normalizeAllowedHosts,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerListTrustedRequest,
  type ConnectorDevServerTrustedRequest
} from '../server/connector-dev-server-contract';
import { ConnectorDevServerCommandExecutor } from '../server/connector-dev-server-executor';

const now = Date.parse('2026-07-11T10:00:00.000Z');

afterEach(() => {
  delete process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64;
});
const baseRequest: ConnectorDevServerTrustedRequest = {
  allowedHosts: ['phone.tail.example', '100.80.135.9'],
  expectedHeadSha: 'a'.repeat(40),
  machineId: 'test-machine',
  projectId: 'test-machine:project-space',
  runTarget: 'dev',
  serverId: 'dev',
  worktreeId: 'wt_111111111111111111111111'
};

function commandGrant(generation = 3, nonce = 'grant-nonce-0000000000000001', issuedAt = now) {
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
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_B64 =
      Buffer.from(pem).toString('base64');

    expect(connectorCommandGrantSigningKey()).toBe(pem.trim());
  });

  test('binds actor, target, operation, allowed hosts, expiry, and generation', () => {
    const { grant, keys, request } = commandGrant();
    const actor = verifyConnectorCommandGrant(grant, request, 'start', keys.publicKey, {
      expectedUserId: 'user_123',
      now: now + 1_000
    });

    expect(actor).toEqual({ generation: 3, userId: 'user_123' });
    expect(isConnectorDevServerWireRequest({ ...request, grant })).toBe(true);
    expect(JSON.stringify({ ...request, grant })).not.toContain('worktreePath');
    expect(
      isConnectorDevServerWireRequest({
        ...request,
        grant,
        worktreePath: '/tmp/attacker'
      })
    ).toBe(false);
    expect(isConnectorDevServerWireRequest({ ...request, grant, unexpected: true })).toBe(false);
    expect(
      isConnectorDevServerResult({
        capability: 'configured',
        checkedAt: '2026-07-11T02:01:02.276654Z',
        generation: 3,
        machineId: request.machineId,
        projectId: request.projectId,
        runTarget: request.runTarget,
        serverId: request.serverId,
        state: 'stopped',
        worktreeId: request.worktreeId
      })
    ).toBe(true);
  });

  test('signs declaration inventory separately from server actions', () => {
    const keys = generateKeyPairSync('ed25519');
    const request: ConnectorDevServerListTrustedRequest = {
      expectedHeadSha: baseRequest.expectedHeadSha,
      machineId: baseRequest.machineId,
      projectId: baseRequest.projectId,
      worktreeId: baseRequest.worktreeId
    };
    const grant = createConnectorCommandGrant(
      {
        actor: { generation: 0, userId: 'user_123' },
        operation: 'list',
        request
      },
      keys.privateKey,
      { nonce: 'grant-nonce-inventory-00000001', now }
    );

    expect(isConnectorDevServerListWireRequest({ ...request, grant })).toBe(true);
    expect(grant).not.toHaveProperty('allowedHosts');
    expect(grant).not.toHaveProperty('serverId');
    expect(grant).not.toHaveProperty('runTarget');
    expect(
      verifyConnectorCommandGrant(grant, request, 'list', keys.publicKey, {
        now
      })
    ).toEqual({ generation: 0, userId: 'user_123' });
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(grant, baseRequest, 'start', keys.publicKey, { now })
      )
    ).toBe('binding-mismatch');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(
          grant,
          { ...request, expectedHeadSha: 'b'.repeat(40) },
          'start',
          keys.publicKey,
          { now }
        )
      )
    ).toBe('binding-mismatch');
  });

  test('accepts dotted stable server ids and bounds inventory results', () => {
    const { keys, request } = commandGrant();
    const dottedRequest = {
      ...request,
      runTarget: 'web.preview',
      serverId: 'web.preview'
    };
    const dottedGrant = createConnectorCommandGrant(
      {
        actor: { generation: 1, userId: 'user_123' },
        operation: 'start',
        request: dottedRequest
      },
      keys.privateKey,
      { nonce: 'dotted-server-nonce-0000000001', now }
    );
    expect(isConnectorDevServerWireRequest({ ...dottedRequest, grant: dottedGrant })).toBe(true);

    const result = {
      capability: 'configured' as const,
      checkedAt: new Date(now).toISOString(),
      generation: 0,
      machineId: request.machineId,
      projectId: request.projectId,
      servers: Array.from({ length: 65 }, (_, index) => ({
        capability: 'configured' as const,
        label: `Server ${index}`,
        serverId: `server.${String(index).padStart(2, '0')}`
      })),
      worktreeId: request.worktreeId
    };
    expect(isConnectorDevServerListResult(result)).toBe(false);
    expect(
      isConnectorDevServerListResult({
        ...result,
        servers: result.servers.slice(0, 64)
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
          { ...request, worktreeId: 'wt_222222222222222222222222' },
          'start',
          keys.publicKey,
          { now }
        )
      )
    ).toBe('binding-mismatch');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(grant, request, 'stop', keys.publicKey, {
          now
        })
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
    verifyConnectorCommandGrant(first.grant, first.request, 'start', first.keys.publicKey, {
      now,
      replayProtection
    });
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(first.grant, first.request, 'start', first.keys.publicKey, {
          now,
          replayProtection
        })
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
        verifyConnectorCommandGrant(staleGrant, first.request, 'start', first.keys.publicKey, {
          now,
          replayProtection
        })
      )
    ).toBe('stale-generation');
    expect(
      errorCode(() =>
        verifyConnectorCommandGrant(first.grant, first.request, 'start', first.keys.publicKey, {
          now: now + 40_000
        })
      )
    ).toBe('expired');
  });

  test('bounds and expires per-server generation replay scopes', () => {
    const keys = generateKeyPairSync('ed25519');
    const replayProtection = new ConnectorCommandReplayProtection(2);
    const accept = (serverId: string, issuedAt: number) => {
      const request = { ...baseRequest, runTarget: serverId, serverId };
      const grant = createConnectorCommandGrant(
        {
          actor: { generation: 1, userId: 'user_123' },
          operation: 'inspect',
          request
        },
        keys.privateKey,
        {
          nonce: `nonce-${serverId}-00000000000000000000`,
          now: issuedAt,
          ttlMs: 1_000
        }
      );
      verifyConnectorCommandGrant(grant, request, 'inspect', keys.publicKey, {
        now: issuedAt,
        replayProtection
      });
    };

    accept('web.one', now);
    accept('web.two', now);
    expect(replayProtection.trackedGenerationCount).toBe(2);
    expect(() => accept('web.three', now)).toThrow('at capacity');

    accept('web.three', now + 6_001);
    expect(replayProtection.trackedGenerationCount).toBe(1);
  });

  test('passes verified actor identity to the adapter and blocks replay before execution', async () => {
    const { grant, keys, request } = commandGrant(3, 'grant-nonce-executor-0000000003', Date.now());
    const executions: Array<{ generation: number; userId: string }> = [];
    const adapter: ConnectorDevServerAdapter = {
      async listDevServers() {
        throw new Error('not used');
      },
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
          serverId: execution.serverId,
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

  test('executes a signed declaration inventory without exposing commands', async () => {
    const keys = generateKeyPairSync('ed25519');
    const request: ConnectorDevServerListTrustedRequest = {
      expectedHeadSha: baseRequest.expectedHeadSha,
      machineId: baseRequest.machineId,
      projectId: baseRequest.projectId,
      worktreeId: baseRequest.worktreeId
    };
    const grant = createConnectorCommandGrant(
      {
        actor: { generation: 0, userId: 'user_123' },
        operation: 'list',
        request
      },
      keys.privateKey,
      { nonce: 'grant-nonce-list-executor-0001', now: Date.now() }
    );
    const adapter: ConnectorDevServerAdapter = {
      async listDevServers(execution) {
        return {
          capability: 'configured',
          checkedAt: new Date().toISOString(),
          generation: execution.actor.generation,
          machineId: execution.machineId,
          projectId: execution.projectId,
          servers: [
            {
              capability: 'configured',
              label: 'Storybook',
              serverId: 'storybook'
            },
            { capability: 'configured', label: 'Web app', serverId: 'web' }
          ],
          worktreeId: execution.worktreeId
        };
      },
      async runDevServerCommand() {
        throw new Error('not used');
      }
    };
    const executor = new ConnectorDevServerCommandExecutor(adapter, keys.publicKey);

    const result = await executor.execute('list', { ...request, grant });

    expect(result).toMatchObject({
      capability: 'configured',
      servers: [
        { label: 'Storybook', serverId: 'storybook' },
        { label: 'Web app', serverId: 'web' }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('command');
  });
  test('rejects a valid grant routed to a different connector machine', async () => {
    const { grant, keys, request } = commandGrant();
    let executed = false;
    const adapter: ConnectorDevServerAdapter = {
      async listDevServers() {
        throw new Error('not used');
      },
      async runDevServerCommand() {
        executed = true;
        throw new Error('must not execute');
      }
    };
    const executor = new ConnectorDevServerCommandExecutor(
      adapter,
      keys.publicKey,
      'different-machine'
    );

    const result = await executor.execute('start', { ...request, grant });

    expect(result).toMatchObject({
      lastError: 'Connector command authorization failed.',
      state: 'error'
    });
    expect(executed).toBe(false);
  });
});
