import { describe, expect, test } from 'bun:test';
import type { DatabaseQueryClient } from '../server/database/client';
import { PostgresTailscaleInventoryStore, TailscaleClassificationRevisionConflict } from '../server/tailscale-inventory/store';

type Observation = { addresses: string[]; freshUntil: string; id: string; name?: string; observedAt: string; os?: string; state: 'current' | 'stale'; staleAt?: string };
type Classification = { actorId: string; classification: string; revision: number };

class InventoryDatabase implements DatabaseQueryClient {
  readonly audits: Array<Record<string, unknown>> = []; readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  blockProjectionDelete = false;
  incompatibleBuiltInField?: 'name' | 'operating_system_family' | 'supported_architectures' | 'bootstrap_strategy';
  private readonly classifications = new Map<string, Classification>(); private readonly observations = new Map<string, Observation>();
  private readonly projections = new Map<string, string>();
  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values }); const owner = String(values[0] ?? ''); const id = String(values[1] ?? '');
    if (sql.includes('insert into tailscale_device_observations')) {
      const nextObservedAt = String(values[7]);
      const current = this.observations.get(this.key(owner, id));
      if (!current || current.observedAt < nextObservedAt) {
        this.observations.set(this.key(owner, id), { addresses: [...values[3] as string[]], freshUntil: String(values[8]), id, name: values[2] ? String(values[2]) : undefined, observedAt: nextObservedAt, os: values[5] ? String(values[5]) : undefined, state: 'current' });
      }
      return { rows: [] as Row[] };
    }
    if (sql.includes("set inventory_state = 'stale'")) {
      const present = new Set(values[2] as string[]);
      const snapshotObservedAt = String(values[1]);
      for (const [key, device] of this.observations) if (key.startsWith(`${owner}:`) && device.state === 'current' && device.observedAt < snapshotObservedAt && !present.has(device.id)) { device.state = 'stale'; device.staleAt = snapshotObservedAt; }
      return { rows: [] as Row[] };
    }
    if (sql.includes('from tailscale_device_observations observations')) return { rows: [...this.observations.entries()].filter(([key]) => key.startsWith(`${owner}:`)).map(([, device]) => {
      const classification = this.classifications.get(this.key(owner, device.id)); return { addresses: device.addresses, classification: classification?.classification ?? null, device_id: device.id, environment_id: this.projections.get(this.key(owner, device.id)) ?? null, fresh_until: device.freshUntil, inventory_state: device.state, last_seen_at: null, observed_at: device.observedAt, observed_name: device.name ?? null, online: true, os: null, revision: classification?.revision ?? null, stale_at: device.staleAt ?? null, tags: ['tag:owner'] };
    }) as Row[] };
    if (sql.includes('from tailscale_compute_environment_projections projection') && sql.includes("classification.classification = 'environment'")) { const current = this.classifications.get(this.key(owner, id)); const environmentId = this.projections.get(this.key(owner, id)); return { rows: current?.classification === 'environment' && environmentId ? [{ revision: current.revision } as Row] : [] }; }
    if (sql.includes('select observed_name, os from tailscale_device_observations')) { const device = this.observations.get(this.key(owner, id)); return { rows: device ? [{ observed_name: device.name ?? null, os: device.os ?? null } as Row] : [] }; }
    if (sql.includes('select device_id from tailscale_device_observations')) { const device = this.observations.get(this.key(owner, id)); return { rows: device ? [{ device_id: device.id } as Row] : [] }; }
    if (sql.includes('select classification, revision from tailscale_device_classifications')) { const current = this.classifications.get(this.key(owner, id)); return { rows: current ? [{ classification: current.classification, revision: current.revision } as Row] : [] }; }
    if (sql.includes('insert into tailscale_device_classifications')) {
      const current = this.classifications.get(this.key(owner, id)); const expected = Number(values[4]); if ((current?.revision ?? 0) !== expected) return { rows: [] as Row[] }; const next = { actorId: String(values[3]), classification: String(values[2]), revision: expected + 1 }; this.classifications.set(this.key(owner, id), next); return { rows: [{ classification: next.classification, revision: next.revision } as Row] };
    }
    if (sql.includes('insert into compute_platforms')) return { rows: [{ id: `platform-${owner}` } as Row] };
    if (sql.includes('insert into compute_environment_definitions')) {
      if (this.incompatibleBuiltInField) return { rows: [] as Row[] };
      return { rows: [{ id: `definition-${String(values[4])}` } as Row] };
    }
    if (sql.includes('insert into compute_environments')) return { rows: [{ id: `environment-${owner}-${id}` } as Row] };
    if (sql.includes('insert into tailscale_compute_environment_projections')) { this.projections.set(this.key(owner, id), String(values[2])); return { rows: [] as Row[] }; }
    if (sql.includes('select environment_id from tailscale_compute_environment_projections')) { const environmentId = this.projections.get(this.key(owner, id)); return { rows: environmentId ? [{ environment_id: environmentId } as Row] : [] }; }
    if (sql.includes('delete from tailscale_compute_environment_projections')) { this.projections.delete(this.key(owner, id)); return { rows: [] as Row[] }; }
    if (sql.includes('delete from compute_environments environment')) {
      if (this.blockProjectionDelete) throw Object.assign(new Error('referenced'), { code: '23503' });
      return { rows: [{ id } as Row] };
    }
    if (sql.includes('insert into tailscale_device_classification_audits')) { this.audits.push({ actorId: values[2], deviceId: values[1], nextClassification: values[4], previousClassification: values[3], revision: values[5] }); return { rows: [] as Row[] }; }
    throw new Error(`Unexpected inventory query: ${sql}`);
  }
  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    const audits = [...this.audits]; const classifications = new Map([...this.classifications].map(([key, value]) => [key, { ...value }])); const projections = new Map(this.projections);
    try { return await operation(this); } catch (error) { this.audits.splice(0, this.audits.length, ...audits); this.classifications.clear(); classifications.forEach((value, key) => this.classifications.set(key, value)); this.projections.clear(); projections.forEach((value, key) => this.projections.set(key, value)); throw error; }
  }
  private key(owner: string, id: string) { return `${owner}:${id}`; }
}

const observedAt = '2026-08-14T09:00:00.000Z';
const storeFor = (database: InventoryDatabase) => new PostgresTailscaleInventoryStore(database);
const device = (id: string, observedName: string, address: string, os = 'linux') => ({ addresses: [address], id, observedName, online: true, os, tags: ['tag:owner'] });
async function reconcile(database: InventoryDatabase, owner: string, devices: unknown[], complete = true, errors = false, at = observedAt) {
  const until = new Date(Date.parse(at) + 60_000).toISOString();
  return storeFor(database).reconcile(owner, { complete, kind: 'snapshot', snapshot: { backendState: 'running', deviceErrors: errors ? [{ code: 'invalid_device', source: 'peer' }] : [], devices: devices as never, freshness: { freshUntil: until, observedAt: at, state: 'fresh' }, source: 'tailscale_status_json' } });
}

describe('Tailscale inventory store', () => {
  test('isolates owners and preserves classification through a name/IP change', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db); await reconcile(db, 'owner-one', [device('device-a', 'old', '100.64.0.1')]); await store.setClassification({ actorId: 'owner-one', classification: 'environment', deviceId: 'device-a', expectedRevision: 0, ownerUserId: 'owner-one' }); await reconcile(db, 'owner-one', [device('device-a', 'new', '100.64.9.9')], true, false, '2026-08-14T09:01:00.000Z'); await reconcile(db, 'owner-two', [device('device-a', 'same', '100.64.0.1')]);
    expect(await store.list('owner-one')).toEqual([expect.objectContaining({ addresses: ['100.64.9.9'], classification: 'environment', observedName: 'new' })]); expect(await store.list('owner-two')).toEqual([expect.objectContaining({ classification: 'unclassified', observedName: 'same' })]);
    expect(db.calls.find(({ sql }) => sql.includes('from tailscale_device_observations observations'))?.sql)
      .toContain('host(address)');
  });
  test('does not stale absent devices for a partial/error snapshot, but does after a complete one', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db); await reconcile(db, 'owner-one', [device('a', 'a', '100.64.0.1'), device('b', 'b', '100.64.0.2')]); await reconcile(db, 'owner-one', [device('a', 'a', '100.64.0.1')], true, true, '2026-08-14T09:01:00.000Z'); expect((await store.list('owner-one')).find(({ id }) => id === 'b')?.state).toBe('current'); await reconcile(db, 'owner-one', [device('a', 'a', '100.64.0.1')], true, false, '2026-08-14T09:02:00.000Z'); expect((await store.list('owner-one')).find(({ id }) => id === 'b')).toMatchObject({ state: 'stale', staleAt: '2026-08-14T09:02:00.000Z' });
  });
  test('takes no writes on provider failure', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db); await reconcile(db, 'owner-one', [device('a', 'a', '100.64.0.1')]); const calls = db.calls.length; await expect(store.reconcile('owner-one', { kind: 'provider-failure', observedAt })).resolves.toEqual({ kind: 'provider-failure', observedAt }); expect(db.calls).toHaveLength(calls);
  });
  test('does not let an older snapshot overwrite or stale newer evidence', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db);
    await reconcile(db, 'owner-one', [device('a', 'new', '100.64.9.9'), device('b', 'new-b', '100.64.0.2')], true, false, '2026-08-14T09:10:00.000Z');
    await reconcile(db, 'owner-one', [device('a', 'old', '100.64.0.1')], true, false, observedAt);
    expect(await store.list('owner-one')).toEqual([
      expect.objectContaining({ addresses: ['100.64.9.9'], id: 'a', observedName: 'new', state: 'current' }),
      expect.objectContaining({ id: 'b', state: 'current' })
    ]);
  });
  test('audits reversible classifications without hostile provider labels or errors', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db); const hostile = '<img src=x onerror=alert(1)>'; await reconcile(db, 'owner-one', [device('a', hostile, '100.64.0.1')]); await store.setClassification({ actorId: 'owner-one', classification: 'environment', deviceId: 'a', expectedRevision: 0, ownerUserId: 'owner-one' }); await store.setClassification({ actorId: 'owner-one', classification: 'unclassified', deviceId: 'a', expectedRevision: 1, ownerUserId: 'owner-one' }); expect(db.audits).toEqual([expect.objectContaining({ nextClassification: 'environment', previousClassification: 'unclassified' }), expect.objectContaining({ nextClassification: 'unclassified', previousClassification: 'environment' })]); expect(JSON.stringify(db.audits)).not.toContain(hostile);
  });
  test('rejects a stale revision', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db); await reconcile(db, 'owner-one', [device('a', 'a', '100.64.0.1')]); await store.setClassification({ actorId: 'owner-one', classification: 'environment', deviceId: 'a', expectedRevision: 0, ownerUserId: 'owner-one' }); await expect(store.setClassification({ actorId: 'owner-one', classification: 'ignored', deviceId: 'a', expectedRevision: 0, ownerUserId: 'owner-one' })).rejects.toBeInstanceOf(TailscaleClassificationRevisionConflict);
  });
  test('projects an idempotent hostless Environment from the stable device id only', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db);
    await reconcile(db, 'owner-one', [device('wsl-device', 'before', '100.64.0.1', 'linux')]);
    await store.setClassification({ actorId: 'owner-one', classification: 'environment', deviceId: 'wsl-device', expectedRevision: 0, ownerUserId: 'owner-one' });
    await reconcile(db, 'owner-one', [device('wsl-device', 'after', '100.64.9.9', 'wsl')], true, false, '2026-08-14T09:01:00.000Z');
    const environment = db.calls.filter(({ sql }) => sql.includes('insert into compute_environments')).at(-1);
    expect(environment?.values).toEqual(expect.arrayContaining(['wsl', 'after']));
    expect(environment?.sql).toContain("'unresolved', 'none'");
    expect(environment?.values.join(' ')).not.toContain('100.64.9.9');
    expect(db.calls.some(({ sql }) => sql.includes('compute_hosts') || sql.includes('connector_compute_environments'))).toBe(false);
    expect(await store.list('owner-one')).toEqual([
      expect.objectContaining({ environmentId: expect.any(String), id: 'wsl-device' })
    ]);
  });
  test('does not reuse a Tailscale built-in definition with an incompatible blueprint field', async () => {
    const fields = [
      'name', 'operating_system_family', 'supported_architectures', 'bootstrap_strategy'
    ] as const;
    for (const field of fields) {
      const db = new InventoryDatabase();
      db.incompatibleBuiltInField = field;
      await reconcile(db, 'owner-one', [device(`device-${field}`, 'mac', '100.64.0.1', 'macos')]);
      await expect(storeFor(db).setClassification({
        actorId: 'owner-one', classification: 'environment', deviceId: `device-${field}`,
        expectedRevision: 0, ownerUserId: 'owner-one'
      })).rejects.toThrow('The Tailscale Environment definition could not be reconciled.');
      const query = db.calls.find(({ sql }) => sql.includes('insert into compute_environment_definitions'))?.sql;
      expect(query).toContain("compute_environment_definitions.ownership = 'built_in'");
      expect(query).toContain(`compute_environment_definitions.${field} = excluded.${field}`);
    }
  });
  test('removes only a projection Environment and turns dependency conflicts into a safe revision conflict', async () => {
    const db = new InventoryDatabase(); const store = storeFor(db);
    await reconcile(db, 'owner-one', [device('a', 'a', '100.64.0.1')]);
    await store.setClassification({ actorId: 'owner-one', classification: 'environment', deviceId: 'a', expectedRevision: 0, ownerUserId: 'owner-one' });
    db.blockProjectionDelete = true;
    await expect(store.setClassification({ actorId: 'owner-one', classification: 'ignored', deviceId: 'a', expectedRevision: 1, ownerUserId: 'owner-one' })).rejects.toMatchObject({ name: 'TailscaleEnvironmentInUse' });
    expect(db.audits).toHaveLength(1);
    await expect(store.setClassification({ actorId: 'owner-one', classification: 'ignored', deviceId: 'a', expectedRevision: 1, ownerUserId: 'owner-one' })).rejects.toMatchObject({ name: 'TailscaleEnvironmentInUse' });
  });
});
