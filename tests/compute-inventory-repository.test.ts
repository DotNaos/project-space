import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';

class InventoryClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  currentEnvironmentIdentityKey = 'account:different';
  currentHostEvidence = 'user';
  currentHostIdentityKey: string | null = null;
  currentHostResolution = 'manual';
  hasCurrentAssociation = false;
  rejectAssociationMove = false;

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('from compute_platforms') && sql.includes('order by lower')) {
      return { rows: [{ id: 'platform-local', kind: 'local', name: 'Local & self-hosted' }] as Row[] };
    }
    if (sql.includes('from compute_hosts') && sql.includes('order by lower')) {
      return { rows: [] as Row[] };
    }
    if (sql.includes('from compute_environments') && sql.includes('order by lower')) {
      return { rows: [{
        host_evidence: 'none',
        host_id: null,
        host_resolution: 'unresolved',
        id: 'environment-one',
        identity_key: 'account:0123456789abcdef',
        identity_resolution: 'resolved',
        identity_version: 1,
        kind: 'native_linux',
        name: 'Ubuntu',
        parent_environment_id: null,
        platform_id: 'platform-local',
        resource_mode: 'dedicated',
        resources: null
      }] as Row[] };
    }
    if (sql.includes('from connector_compute_environments') && sql.includes('order by connector_id')) {
      return { rows: [{
        associated_at: '2026-08-08T00:00:00.000Z',
        connector_id: 'connector-one',
        environment_id: 'environment-one'
      }] as Row[] };
    }
    if (sql.includes('from machine_memberships') && sql.includes('for update')) {
      return { rows: [{ machine_id: 'connector-one' }] as Row[] };
    }
    if (sql.includes('insert into compute_platforms')) {
      return { rows: [{ id: 'platform-local' }] as Row[] };
    }
    if (sql.includes('from connector_compute_environments association') && sql.includes('for update')) {
      return { rows: (this.rejectAssociationMove || this.hasCurrentAssociation ? [{
        association_source: 'connector',
        environment_id: 'environment-existing',
        host_evidence: this.currentHostEvidence,
        host_id: this.currentHostIdentityKey ? 'host-existing' : null,
        host_identity_key: this.currentHostIdentityKey,
        host_resolution: this.currentHostResolution,
        identity_key: this.currentEnvironmentIdentityKey,
        platform_id: 'platform-local'
      }] : []) as Row[] };
    }
    if (sql.includes('insert into compute_environments')) {
      return { rows: [{ id: 'environment-reported' }] as Row[] };
    }
    if (sql.includes('insert into connector_compute_environments')) {
      return {
        rows: (this.rejectAssociationMove ? [] : [{ environment_id: 'environment-reported' }]) as Row[]
      };
    }
    return { rows: [] as Row[] };
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    return operation(this);
  }
}

const reported = {
  environmentIdentity: { key: 'environment:0123456789abcdef', version: 1 },
  environmentKind: 'native_linux' as const,
  environmentName: 'Ubuntu',
  hostEvidence: 'none' as const,
  hostResolution: 'unresolved' as const,
  platformKind: 'local' as const,
  platformName: 'Local & self-hosted',
  resourceMode: 'dedicated' as const
};

describe('compute inventory repository', () => {
  test('maps an owner-scoped inventory with no missing connector environments', async () => {
    const repository = new ProjectSpaceDatabaseRepository(new InventoryClient());
    const inventory = await repository.listComputeInventory('user-one');
    expect(inventory.violations).toEqual([]);
    expect(inventory.connectors).toEqual([{
      associatedAt: '2026-08-08T00:00:00.000Z',
      connectorId: 'connector-one',
      environmentId: 'environment-one'
    }]);
    expect(inventory.environments[0]?.identityResolution).toBe('resolved');
  });

  test('account-scopes a connector identity before persistence', async () => {
    const client = new InventoryClient();
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');
    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }]);
    const environmentInsert = client.calls.find(({ sql }) => sql.includes('insert into compute_environments'));
    expect(environmentInsert?.values[6]).toMatch(/^account:[0-9a-f]{64}$/);
    expect(environmentInsert?.values[6]).not.toContain(reported.environmentIdentity.key);
  });

  test('marks a post-reconciliation environment move as an explicit conflict', async () => {
    const client = new InventoryClient();
    client.rejectAssociationMove = true;
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');
    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }]);
    const conflict = client.calls.find(({ sql }) => (
      sql.includes("set identity_resolution = 'conflict'")
    ));
    expect(conflict?.values).toEqual(['environment-existing', 'user-one']);
    expect(client.calls.some(({ sql }) => sql.includes('insert into compute_environments')))
      .toBe(false);
  });

  test('marks contradictory physical-host evidence instead of moving the environment', async () => {
    const client = new InventoryClient();
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');
    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }]);
    const initialEnvironment = client.calls.find(({ sql }) => sql.includes('insert into compute_environments'));
    client.currentEnvironmentIdentityKey = String(initialEnvironment?.values[6]);
    client.currentHostIdentityKey = 'account:existing-host';
    client.rejectAssociationMove = true;
    client.calls.length = 0;
    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: {
        ...reported,
        hostEvidence: 'smbios',
        hostIdentity: { key: 'host:reported0123456789', version: 1 },
        hostName: 'Laptop',
        hostResolution: 'verified'
      },
      id: 'connector-one',
      name: 'connector-one'
    }]);
    expect(client.calls.some(({ sql }) => sql.includes("host_resolution = 'conflict'")))
      .toBe(true);
    expect(client.calls.some(({ sql }) => sql.includes("identity_resolution = 'conflict'")))
      .toBe(false);
    expect(client.calls.some(({ sql }) => sql.includes('insert into compute_hosts')))
      .toBe(false);
  });

  test('preserves an explicit host binding when a connector cannot report host identity', async () => {
    const client = new InventoryClient();
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');
    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }]);
    const initialEnvironment = client.calls.find(({ sql }) => sql.includes('insert into compute_environments'));
    client.currentEnvironmentIdentityKey = String(initialEnvironment?.values[6]);
    client.currentHostIdentityKey = 'account:existing-host';
    client.hasCurrentAssociation = true;
    client.calls.length = 0;

    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }]);

    const reconciledEnvironment = client.calls.find(({ sql }) => sql.includes('insert into compute_environments'));
    expect(reconciledEnvironment?.values[3]).toBe('host-existing');
    expect(reconciledEnvironment?.values[9]).toBe('manual');
    expect(reconciledEnvironment?.values[10]).toBe('user');
  });
});
