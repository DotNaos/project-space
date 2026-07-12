import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  createConnectorWorktreeActionGrant,
  verifyConnectorWorktreeActionGrant,
  WorktreeActionReplayProtection
} from '../server/connector-worktree-action-grant';
import { ConnectorWorktreeActionExecutor } from '../server/connector-worktree-action-executor';
import {
  isConnectorWorktreeActionWireRequest,
  type ConnectorWorktreeMaterializeTrustedRequest,
  type ConnectorWorktreeSetupTrustedRequest
} from '../server/connector-worktree-action-contract';

const request: ConnectorWorktreeMaterializeTrustedRequest = {
  branchName: 'feature/remote-dev',
  commitSha: 'a'.repeat(40),
  machineId: 'machine-1',
  operation: 'materialize',
  projectId: 'github:42',
  repositoryFullName: 'DotNaos/project-space'
};

describe('connector worktree action grant', () => {
  test('binds the exact repository branch commit actor generation and operation', () => {
    const pair = generateKeyPairSync('ed25519');
    const now = Date.parse('2026-07-12T10:00:00Z');
    const grant = createConnectorWorktreeActionGrant(
      'materialize',
      request,
      { generation: 7, userId: 'user-a' },
      pair.privateKey,
      { now, nonce: 'nonce-a' }
    );
    expect(isConnectorWorktreeActionWireRequest({ ...request, grant })).toBe(true);
    expect(
      verifyConnectorWorktreeActionGrant(grant, 'materialize', request, pair.publicKey, { now })
    ).toEqual({ generation: 7, userId: 'user-a' });
    expect(() =>
      verifyConnectorWorktreeActionGrant(
        grant,
        'materialize',
        { ...request, commitSha: 'b'.repeat(40) },
        pair.publicKey,
        { now }
      )
    ).toThrow('binding');
  });
  test('rejects replay and malformed wire binding', () => {
    const pair = generateKeyPairSync('ed25519');
    const now = Date.now();
    const replay = new WorktreeActionReplayProtection();
    const grant = createConnectorWorktreeActionGrant(
      'materialize',
      request,
      { generation: 8, userId: 'user-a' },
      pair.privateKey,
      { now }
    );
    verifyConnectorWorktreeActionGrant(grant, 'materialize', request, pair.publicKey, {
      now,
      replay
    });
    expect(() =>
      verifyConnectorWorktreeActionGrant(grant, 'materialize', request, pair.publicKey, {
        now,
        replay
      })
    ).toThrow('replayed');
    expect(
      isConnectorWorktreeActionWireRequest({
        ...request,
        commitSha: 'b'.repeat(40),
        grant
      })
    ).toBe(false);
  });
  test('signs setup by opaque worktree and exact HEAD without accepting a path', () => {
    const pair = generateKeyPairSync('ed25519');
    const now = Date.now();
    const setup: ConnectorWorktreeSetupTrustedRequest = {
      declarationDigest: 'b'.repeat(64),
      expectedHeadSha: 'a'.repeat(40),
      machineId: 'machine-1',
      operation: 'setup.run',
      projectId: 'connector-project:bWFjaGluZS0x:bG9jYWwtcHJvamVjdA',
      repositoryFullName: 'DotNaos/project-space',
      setupStepId: 'install',
      worktreeId: 'wt_111111111111111111111111'
    };
    const grant = createConnectorWorktreeActionGrant(
      'setup.run',
      setup,
      { generation: 3, userId: 'user-a' },
      pair.privateKey,
      { now }
    );

    expect(isConnectorWorktreeActionWireRequest({ ...setup, grant })).toBe(true);
    expect(JSON.stringify({ ...setup, grant })).not.toContain('worktreePath');
    expect(() =>
      verifyConnectorWorktreeActionGrant(
        grant,
        'setup.run',
        { ...setup, expectedHeadSha: 'c'.repeat(40) },
        pair.publicKey,
        { now }
      )
    ).toThrow('binding');
    expect(
      isConnectorWorktreeActionWireRequest({
        ...setup,
        grant,
        worktreePath: '/tmp/attacker'
      })
    ).toBe(false);
  });
  test('rejects an older generation even with a fresh nonce', () => {
    const pair = generateKeyPairSync('ed25519');
    const now = Date.now();
    const replay = new WorktreeActionReplayProtection();
    const newer = createConnectorWorktreeActionGrant(
      'materialize',
      request,
      { generation: 10, userId: 'user-a' },
      pair.privateKey,
      { now, nonce: 'newer' }
    );
    const older = createConnectorWorktreeActionGrant(
      'materialize',
      request,
      { generation: 9, userId: 'user-a' },
      pair.privateKey,
      { now, nonce: 'older' }
    );
    verifyConnectorWorktreeActionGrant(newer, 'materialize', request, pair.publicKey, {
      now,
      replay
    });
    expect(() =>
      verifyConnectorWorktreeActionGrant(older, 'materialize', request, pair.publicKey, {
        now,
        replay
      })
    ).toThrow('stale');
  });
  test('prunes expired replay entries instead of growing without bound', () => {
    const pair = generateKeyPairSync('ed25519');
    const replay = new WorktreeActionReplayProtection();
    const now = Date.now();
    const first = createConnectorWorktreeActionGrant(
      'materialize',
      request,
      { generation: 1, userId: 'user-a' },
      pair.privateKey,
      { now, nonce: 'first', ttlMs: 1 }
    );
    replay.accept(first, now);
    expect(replay.trackedNonceCount).toBe(1);
    const later = createConnectorWorktreeActionGrant(
      'materialize',
      request,
      { generation: 2, userId: 'user-a' },
      pair.privateKey,
      { now: now + 6_000, nonce: 'later', ttlMs: 1 }
    );
    replay.accept(later, now + 6_000);
    expect(replay.trackedNonceCount).toBe(1);
  });
  test('rejects a valid action routed to a different connector machine', async () => {
    const pair = generateKeyPairSync('ed25519');
    const now = Date.now();
    const grant = createConnectorWorktreeActionGrant(
      'materialize',
      request,
      { generation: 1, userId: 'user-a' },
      pair.privateKey,
      { now }
    );
    let executed = false;
    const executor = new ConnectorWorktreeActionExecutor(
      {
        async runWorktreeAction() {
          executed = true;
          throw new Error('must not execute');
        }
      },
      pair.publicKey,
      'different-machine'
    );

    await expect(executor.execute('materialize', { ...request, grant })).rejects.toThrow(
      'invalid worktree action'
    );
    expect(executed).toBe(false);
  });
});
