import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { PostgresLegacyConnectorCleanupStore } from '../server/legacy-connector-cleanup/store';

type Legacy = { connector_id: string; environment_id: string; label: string; machine_updated_at: string };

class CleanupDatabase implements DatabaseQueryClient {
  blockers = new Map<string, Record<string, number>>();
  readonly receipts = new Map<string, string>();
  readonly rows = new Map<string, Legacy>([
    ['legacy-a', { connector_id: 'legacy-a', environment_id: '00000000-0000-4000-8000-000000000001', label: 'Mac\nBook', machine_updated_at: '2026-08-16T09:00:00.000Z' }],
    ['legacy-b', { connector_id: 'legacy-b', environment_id: '00000000-0000-4000-8000-000000000002', label: 'Old B', machine_updated_at: '2026-08-16T09:00:00.000Z' }]
  ]);
  async query<Row>(sql: string, values: readonly unknown[] = []) {
    const connector = String(values[1] ?? '');
    if (sql.includes('from connector_compute_environments association') && sql.includes('order by association.connector_id')) {
      return { rows: [...this.rows.values()].filter((row) => !this.receipts.has(row.connector_id)).map((row) => ({ ...row, canonical_kind: row.connector_id === 'legacy-a' ? 'tailscale' : null })) as Row[] };
    }
    if (sql.includes('from legacy_connector_removal_receipts') && sql.includes('for update')) {
      const value = this.receipts.get(connector); return { rows: value ? [{ fingerprint_sha256: value } as Row] : [] };
    }
    if (sql.includes('for update of association, membership')) {
      const row = this.rows.get(connector); return { rows: row && !this.receipts.has(connector) ? [{ ...row, canonical_kind: null } as Row] : [] };
    }
    if (sql.includes('from connector_credentials credential')) return { rows: [{ active_credential: 0, physical_host_mapping: 0, execution_scope: 0, run_destination: 0, task_execution: 0, workspace_runtime: 0, codex_route: 0, codex_snapshot: 0, dev_server: 0, connector_operation: 0, ...(this.blockers.get(connector) ?? {}) } as Row] };
    if (sql.includes('insert into legacy_connector_removal_receipts')) {
      const insertedConnector = String(values[4]);
      if (this.receipts.has(insertedConnector)) return { rows: [] as Row[] };
      this.receipts.set(insertedConnector, String(values[5])); return { rows: [{ id: String(values[0]) } as Row] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  }
  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) { return operation(this); }
}

describe('legacy Connector cleanup store', () => {
  test('blocks dependencies, permits an independent record, and does not expose provider details', async () => {
    const database = new CleanupDatabase(); database.blockers.set('legacy-a', { task_execution: 1 });
    const store = new PostgresLegacyConnectorCleanupStore(database, () => '00000000-0000-4000-8000-000000000099');
    const snapshot = await store.listSnapshot('owner-one');
    expect(snapshot.records).toEqual(expect.arrayContaining([expect.objectContaining({ connectorId: 'legacy-a', eligible: false, label: 'Mac Book', replacement: { environmentId: '00000000-0000-4000-8000-000000000001', kind: 'tailscale' } })]));
    const a = snapshot.records.find(({ connectorId }) => connectorId === 'legacy-a')!;
    const b = snapshot.records.find(({ connectorId }) => connectorId === 'legacy-b')!;
    const result = await store.remove('owner-one', { actorId: 'owner-one', requestId: 'request-1', records: [{ connectorId: a.connectorId, fingerprint: a.fingerprint }, { connectorId: b.connectorId, fingerprint: b.fingerprint }] });
    expect(result.results.map(({ outcome }) => outcome)).toEqual(['blocked', 'removed']);
    expect(database.receipts.has('legacy-a')).toBeFalse();
    expect(database.receipts.has('legacy-b')).toBeTrue();
  });

  test('fails closed on identity mismatch and makes retries idempotent', async () => {
    const database = new CleanupDatabase(); const store = new PostgresLegacyConnectorCleanupStore(database);
    const target = (await store.listSnapshot('owner-one')).records[0]!;
    await expect(store.remove('owner-one', { actorId: 'owner-one', requestId: 'request-1', records: [{ connectorId: target.connectorId, fingerprint: 'f'.repeat(64) }] })).resolves.toMatchObject({ results: [{ outcome: 'conflict' }] });
    await expect(store.remove('owner-one', { actorId: 'owner-one', requestId: 'request-2', records: [{ connectorId: target.connectorId, fingerprint: target.fingerprint }] })).resolves.toMatchObject({ results: [{ outcome: 'removed' }] });
    await expect(store.remove('owner-one', { actorId: 'owner-one', requestId: 'request-3', records: [{ connectorId: target.connectorId, fingerprint: target.fingerprint }] })).resolves.toMatchObject({ results: [{ outcome: 'already_removed' }] });
    expect((await store.listSnapshot('owner-one')).records.map(({ connectorId }) => connectorId)).not.toContain('legacy-a');
  });
});
