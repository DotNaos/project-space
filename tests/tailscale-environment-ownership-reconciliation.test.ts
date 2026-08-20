import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';
import {
  lockTailscaleEnvironmentOwnershipReconciliation,
  reconcileTailscaleEnvironmentOwnership,
  tailscaleDeploymentOwner
} from '../server/database/tailscale-environment-ownership-reconciler';
import { PostgresTailscaleInventoryStore } from '../server/tailscale-inventory/store';

const userId = 'user-owner';

class LifecycleDatabase implements DatabaseQueryClient {
  readonly calls: string[] = [];
  copyCount = 0;
  copied = false;
  freshEvidence = false;
  hostMembership = true;
  ambiguous = false;
  userDefinedEvidence = false;

  private transactionTail = Promise.resolve();

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push(sql);
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] as Row[] };

    if (sql.includes('with candidate_rows')) {
      if (this.freshEvidence && this.hostMembership && !this.ambiguous &&
          !this.userDefinedEvidence && !this.copied) {
        this.copied = true;
        this.copyCount += 1;
      }
      return { rows: [] as Row[] };
    }
    if (sql.includes('insert into tailscale_device_observations')) {
      this.freshEvidence = true;
      return { rows: [] as Row[] };
    }
    if (sql.includes('select classification.revision')) return { rows: [{ revision: 1 }] as Row[] };
    if (sql.includes('select observed_name, os')) {
      return { rows: [{ observed_name: 'os-pc.tail1234.ts.net', os: 'darwin' }] as Row[] };
    }
    if (sql.includes('insert into compute_platforms')) return { rows: [{ id: 'platform' }] as Row[] };
    if (sql.includes('insert into compute_environment_definitions')) {
      return { rows: [{ id: 'definition' }] as Row[] };
    }
    if (sql.includes('insert into compute_environments')) return { rows: [{ id: 'environment' }] as Row[] };
    if (sql.includes('insert into tailscale_compute_environment_projections')) {
      return { rows: [] as Row[] };
    }
    if (sql.includes('from machine_memberships') && sql.includes('machine_id = any')) {
      return { rows: this.hostMembership ? [{ machine_id: 'connector' }] as Row[] : [] as Row[] };
    }
    if (sql.includes('insert into physical_machines')) {
      return { rows: [{ id: values[0], name: values[2] }] as Row[] };
    }
    if (sql.includes('from compute_platforms') && sql.includes("kind = 'local'")) {
      return { rows: [{ id: 'platform' }] as Row[] };
    }
    return { rows: [] as Row[] };
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    const run = this.transactionTail.then(() => operation(this));
    this.transactionTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

const freshSnapshot = {
  backendState: 'running' as const,
  deviceErrors: [],
  devices: [{
    addresses: ['100.64.0.10'],
    id: 'device-1',
    observedName: 'os-pc.tail1234.ts.net',
    online: true,
    os: 'darwin',
    tags: []
  }],
  freshness: {
    freshUntil: '2026-08-21T00:00:00.000Z',
    observedAt: '2026-08-20T23:00:00.000Z',
    state: 'fresh' as const
  },
  source: 'tailscale_status_json' as const
};

async function reconcileDirect(client: LifecycleDatabase) {
  await lockTailscaleEnvironmentOwnershipReconciliation(client);
  await reconcileTailscaleEnvironmentOwnership(client);
}

describe('repeatable Tailscale Environment ownership reconciliation', () => {
  test('repairs a stale-at-startup candidate when a fresh projection arrives', async () => {
    const client = new LifecycleDatabase();
    client.freshEvidence = false;
    await reconcileDirect(client);
    expect(client.copyCount).toBe(0);

    const store = new PostgresTailscaleInventoryStore(client);
    await store.reconcile(tailscaleDeploymentOwner, {
      complete: true,
      kind: 'snapshot',
      snapshot: freshSnapshot
    });

    expect(client.copyCount).toBe(1);
    expect(client.calls.findLastIndex((sql) => sql.includes('insert into tailscale_device_observations')))
      .toBeLessThan(client.calls.findLastIndex((sql) => sql.includes('with candidate_rows')));
  });

  test('repairs after a Host membership is added after startup', async () => {
    const client = new LifecycleDatabase();
    client.freshEvidence = true;
    client.hostMembership = false;
    await reconcileDirect(client);
    expect(client.copyCount).toBe(0);

    client.hostMembership = true;
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'host-id');
    await repository.savePhysicalMachine({
      connectorIds: ['connector'],
      name: 'os-pc',
      userId
    });

    expect(client.copyCount).toBe(1);
  });

  test('repeated reconciliation is a database no-op and ambiguity never repairs', async () => {
    const client = new LifecycleDatabase();
    client.freshEvidence = true;
    await reconcileDirect(client);
    await reconcileDirect(client);
    expect(client.copyCount).toBe(1);

    const ambiguous = new LifecycleDatabase();
    ambiguous.freshEvidence = true;
    ambiguous.ambiguous = true;
    await reconcileDirect(ambiguous);
    expect(ambiguous.copyCount).toBe(0);
  });

  test('serializes concurrent Host updates so one UUID copy is created', async () => {
    const client = new LifecycleDatabase();
    client.freshEvidence = true;
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'host-id');

    await Promise.all([
      repository.savePhysicalMachine({ connectorIds: ['connector'], name: 'os-pc', userId }),
      repository.savePhysicalMachine({ connectorIds: ['connector'], name: 'os-pc', userId })
    ]);

    expect(client.copyCount).toBe(1);
    expect(client.calls.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
  });

  test('keeps the migration historical and the reconciler fail-closed', async () => {
    const client = new LifecycleDatabase();
    client.freshEvidence = true;
    client.userDefinedEvidence = true;
    await reconcileDirect(client);
    expect(client.copyCount).toBe(0);

    const sql = client.calls.find((call) => call.includes('with candidate_rows')) ?? '';
    expect(sql).toContain("observation.inventory_state = 'current'");
    expect(sql).toContain('observation.fresh_until > now()');
    expect(sql).toContain('count(distinct connector_id) = 1');
    expect(sql).toContain('count(distinct host_id) = 1');
    expect(sql).toContain("existing_definition.ownership = 'user_defined'");
    expect(sql).toContain("platform.kind = 'local'");
    expect(sql).toContain("platform.name = 'Local & self-hosted'");
  });
});
