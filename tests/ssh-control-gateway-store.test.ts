import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import type { SshGatewayAuditEvidence } from '../server/ssh-control-gateway/contracts';
import { OnePasswordSshCredentialResolver } from '../server/ssh-control-gateway/one-password-resolver';
import { PostgresSshGatewayOperationStore } from '../server/ssh-control-gateway/postgres-store';

const owner = 'owner-1';
const environmentId = '11111111-1111-4111-8111-111111111111';
const routeId = '22222222-2222-4222-8222-222222222222';
const fingerprint = 'a'.repeat(64);

describe('SSH control gateway durable store', () => {
  test('reserves, marks dispatch, and persists only the typed safe result', async () => {
    const client = new GatewayStoreClient();
    const store = new PostgresSshGatewayOperationStore(client);
    const reserved = await store.reserve({
      audit: audit(), fingerprint, operationId: 'op-1', ownerUserId: owner,
      targetEnvironmentId: environmentId
    });
    expect(reserved.replayed).toBe(false);
    await store.markDispatchAttempted({ fingerprint, operationId: 'op-1', ownerUserId: owner });
    const completed = await store.complete({
      audit: { ...audit(), outcome: 'succeeded' },
      fingerprint,
      operationId: 'op-1', ownerUserId: owner,
      result: statusResult(), state: 'succeeded'
    });
    expect(completed.result).toEqual(statusResult());
    const serialized = JSON.stringify(client.calls);
    for (const forbidden of [
      'private_address', 'ssh_user', 'host_key', 'credential_reference',
      'PRIVATE KEY', 'stdout', 'stderr'
    ]) expect(serialized).not.toContain(forbidden);
    expect(client.events).toEqual(['reserved', 'dispatch_attempted', 'succeeded']);
  });

  test('rejects changed identity and unknown result fields', async () => {
    const existing = new GatewayStoreClient();
    existing.row = operationRow({ fingerprint_sha256: 'b'.repeat(64), state: 'succeeded' });
    const store = new PostgresSshGatewayOperationStore(existing);
    await expect(store.reserve({
      audit: audit(), fingerprint, operationId: 'op-1', ownerUserId: owner,
      targetEnvironmentId: environmentId
    })).rejects.toMatchObject({ code: 'operation_conflict' });

    const fresh = new GatewayStoreClient();
    fresh.row = operationRow({ state: 'dispatching' });
    for (const unsafe of [
      { ...statusResult(), privateAddress: '100.64.0.10' },
      { ...statusResult(), operationId: 'op-other' },
      { ...statusResult(), targetIdentityRevision: '1:environment:other' }
    ]) {
      await expect(new PostgresSshGatewayOperationStore(fresh).complete({
        audit: audit(), fingerprint, operationId: 'op-1', ownerUserId: owner,
        result: unsafe, state: 'succeeded'
      })).rejects.toMatchObject({ code: 'operation_conflict' });
    }
  });

  test('refuses a client that cannot keep operation and audit writes atomic', () => {
    expect(() => new PostgresSshGatewayOperationStore({
      query: async () => ({ rows: [] })
    })).toThrow('requires database transactions');
  });

  test('rejects mismatched redundant reservation identities before taking locks', async () => {
    const client = new GatewayStoreClient();
    await expect(new PostgresSshGatewayOperationStore(client).reserve({
      audit: { ...audit(), operationId: 'different' }, fingerprint,
      operationId: 'op-1', ownerUserId: owner, targetEnvironmentId: environmentId
    })).rejects.toMatchObject({ code: 'operation_conflict' });
    expect(client.calls).toHaveLength(0);
  });

  test('renews an expired exact reservation without bypassing its fingerprint', async () => {
    const client = new GatewayStoreClient();
    client.row = operationRow({ reserved_until: '2026-08-12T00:00:00.000Z' });
    client.renewExpired = true;
    const reserved = await new PostgresSshGatewayOperationStore(client).reserve({
      audit: audit(), fingerprint, operationId: 'op-1', ownerUserId: owner,
      targetEnvironmentId: environmentId
    });
    expect(reserved.replayed).toBe(false);
    expect(client.events).toEqual(['reservation_expired', 'reserved']);
  });

  test('explicit reconciliation resolves a crashed dispatch without redispatching it', async () => {
    const client = new GatewayStoreClient();
    client.row = operationRow({ state: 'dispatching' });
    const store = new PostgresSshGatewayOperationStore(client);

    const reconciled = await store.reconcile({
      audit: { ...audit(), outcome: 'failed' }, fingerprint,
      operationId: 'op-1', ownerUserId: owner, state: 'failed'
    });

    expect(reconciled.state).toBe('failed');
    expect(client.events).toEqual(['reconciled_failed']);
    expect(client.calls.some(({ sql }) =>
      sql.includes("state in ('dispatching', 'uncertain')"))).toBe(true);
  });
});

test('1Password resolver uses only the opaque reference and hides command failures', async () => {
  let received = '';
  const resolver = new OnePasswordSshCredentialResolver({
    read: async (reference) => {
      received = reference;
      return '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';
    }
  });
  const credential = await resolver.resolve('op://Vault/Item/private-key');
  expect(received).toBe('op://Vault/Item/private-key');
  expect(credential.privateKey).toContain('OPENSSH PRIVATE KEY');
  await expect(new OnePasswordSshCredentialResolver({
    read: async () => { throw new Error('raw secret service failure'); }
  }).resolve('op://Vault/Item/private-key')).rejects.toMatchObject({
    code: 'credential_unavailable', message: 'SSH credential is unavailable.'
  });
});

class GatewayStoreClient implements DatabaseQueryClient {
  calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  events: string[] = [];
  renewExpired = false;
  row?: ReturnType<typeof operationRow>;

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('select pg_advisory')) return { rows: [] as Row[] };
    if (sql.includes('from ssh_gateway_operations') && sql.includes('for update')) {
      return { rows: (this.row ? [this.row] : []) as Row[] };
    }
    if (sql.includes('select 1 from ssh_gateway_operations')) return { rows: [] as Row[] };
    if (sql.includes("set reserved_until = now() + interval '1 minute'")) {
      return { rows: (this.renewExpired && this.row ? [this.row] : []) as Row[] };
    }
    if (sql.includes('insert into ssh_gateway_operation_events')) {
      this.events.push(String(values[2]));
      return { rows: [] as Row[] };
    }
    if (sql.includes("set state = 'dispatching'")) {
      if (this.row) this.row.state = 'dispatching';
      return { rows: [{ operation_id: 'op-1' }] as Row[] };
    }
    if (sql.includes('set state = $3')) {
      const state = String(values[2]) as ReturnType<typeof operationRow>['state'];
      this.row = operationRow({
        completed_at: new Date().toISOString(),
        safe_result: values[3] ? JSON.parse(String(values[3])) : null,
        state
      });
      return { rows: [this.row] as Row[] };
    }
    if (sql.includes('insert into ssh_gateway_operations')) {
      this.row = operationRow({ state: 'reserved' });
    }
    return { rows: [] as Row[] };
  }
}

function audit(): SshGatewayAuditEvidence {
  return {
    actorId: 'actor-1', actorKind: 'machine', capability: 'project_cli',
    gatewayId: 'gateway-1', operation: 'status.v1', operationId: 'op-1',
    outcome: 'accepted', routeClass: 'ssh_private_network', routeId,
    targetEnvironmentId: environmentId, targetIdentityRevision: '1:environment:test'
  };
}

function statusResult() {
  return {
    checkedAt: '2026-08-12T00:00:00.000Z', operation: 'status.v1' as const,
    operationId: 'op-1', schemaVersion: 1 as const, state: 'ready' as const,
    targetIdentityRevision: '1:environment:test', type: 'result' as const
  };
}

function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    actor_id: 'actor-1', actor_kind: 'machine' as const, capability: 'project_cli' as const,
    completed_at: null as string | null, environment_id: environmentId,
    fingerprint_sha256: fingerprint, gateway_id: 'gateway-1', operation: 'status.v1' as const,
    operation_id: 'op-1', route_id: routeId, safe_result: null as unknown,
    reserved_until: null as string | null,
    state: 'reserved' as 'reserved' | 'dispatching' | 'succeeded' | 'failed' | 'incompatible' | 'uncertain',
    target_identity_revision: '1:environment:test', ...overrides
  };
}
