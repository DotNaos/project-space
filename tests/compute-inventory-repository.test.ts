import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { ProjectSpaceDatabaseRepository } from '../server/database/repository';

class InventoryClient implements DatabaseQueryClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  currentEnvironmentIdentityKey = 'account:different';
  currentHostEvidence = 'user';
  currentHostIdentityKey: string | null = null;
  currentHostResolution = 'manual';
  duplicateBuiltInDefinitions = false;
  incompatibleBuiltInFields: Array<
    'name' | 'operating_system_family' | 'supported_architectures' | 'bootstrap_strategy'
  > = [];
  existingDefinitionId = 'definition-native_linux';
  hasCurrentAssociation = false;
  rejectAssociationMove = false;
  retiredConnector = false;
  sameUuidAcrossOwners = false;

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql.includes('from compute_environment_definitions') && sql.includes('order by lower')) {
      const definitions = [{
        bootstrap_strategy: 'ssh',
        id: 'definition-linux',
        kind: 'native_linux',
        name: 'Linux',
        operating_system_family: 'linux',
        ownership: 'built_in',
        slug: 'linux',
        supported_architectures: []
      }, ...(this.duplicateBuiltInDefinitions ? [{
        bootstrap_strategy: 'ssh',
        id: 'definition-linux-duplicate',
        kind: 'native_linux',
        name: 'Linux',
        operating_system_family: 'linux',
        ownership: 'built_in',
        slug: 'linux',
        supported_architectures: []
      }] : [])];
      return { rows: definitions as Row[] };
    }
    if (sql.includes('from compute_platforms') && sql.includes('order by lower')) {
      return { rows: [{ id: 'platform-local', kind: 'local', name: 'Local & self-hosted' }] as Row[] };
    }
    if (sql.includes('from compute_hosts') && sql.includes('order by lower')) {
      const owners = values[0];
      if (this.sameUuidAcrossOwners) {
        const rows = [
          { id: 'shared-host', identity_key: 'account:user-host', identity_version: 1, name: 'User Host', platform_id: 'platform-local', resources: null },
          ...(Array.isArray(owners) && owners.includes('project-space:tailscale-deployment')
            ? [{ id: 'shared-host', identity_key: 'account:deployment-host', identity_version: 1, name: 'Deployment Host', platform_id: 'platform-local', resources: null }]
            : [])
        ];
        return { rows: rows as Row[] };
      }
      return { rows: [] as Row[] };
    }
    if (sql.includes('from compute_environments') && sql.includes('order by lower')) {
      const environments = [{
        host_evidence: 'none',
        host_id: null,
        host_resolution: 'unresolved',
        id: 'environment-one',
        environment_definition_id: 'definition-linux',
        identity_key: 'account:0123456789abcdef',
        identity_resolution: 'resolved',
        identity_version: 1,
        kind: 'native_linux',
        name: 'Ubuntu',
        parent_environment_id: null,
        platform_id: 'platform-local',
        resource_mode: 'dedicated',
        resources: null,
        legacy_tombstoned_only: this.retiredConnector
      }, ...(this.duplicateBuiltInDefinitions ? [{
        host_evidence: 'none',
        host_id: null,
        host_resolution: 'unresolved',
        id: 'environment-two',
        environment_definition_id: 'definition-linux-duplicate',
        identity_key: 'account:fedcba9876543210',
        identity_resolution: 'resolved',
        identity_version: 1,
        kind: 'native_linux',
        name: 'Ubuntu 2',
        parent_environment_id: null,
        platform_id: 'platform-local',
        resource_mode: 'dedicated',
        resources: null,
        legacy_tombstoned_only: false
      }] : [])];
      const owners = values[0];
      if (this.sameUuidAcrossOwners) {
        environments[0] = {
          ...environments[0]!,
          id: 'shared-environment',
          identity_key: 'account:user-environment'
        };
        if (Array.isArray(owners) && owners.includes('project-space:tailscale-deployment')) {
          environments.push({
            ...environments[0]!,
            identity_key: 'account:deployment-environment',
            name: 'Deployment Environment'
          });
        }
      }
      return { rows: environments as Row[] };
    }
    if (sql.includes('from connector_compute_environments') && sql.includes('order by connector_id')) {
      return { rows: this.retiredConnector ? [] : [{
        associated_at: '2026-08-08T00:00:00.000Z',
        connector_id: 'connector-one',
        environment_id: 'environment-one'
      }] as Row[] };
    }
    if (sql.includes('select connector_id from legacy_connector_removal_receipts')) {
      return { rows: this.retiredConnector ? [{ connector_id: 'connector-one' } as Row] : [] as Row[] };
    }
    if (sql.includes('from machine_memberships') && sql.includes('for update')) {
      return { rows: [{ machine_id: 'connector-one' }] as Row[] };
    }
    if (sql.includes('insert into compute_platforms')) {
      return { rows: [{ id: 'platform-local' }] as Row[] };
    }
    if (sql.includes('insert into compute_environment_definitions')) {
      const guardedFields = this.incompatibleBuiltInFields.every((field) => (
        sql.includes(`compute_environment_definitions.${field} = excluded.${field}`)
      ));
      return {
        rows: guardedFields && this.incompatibleBuiltInFields.length > 0
          ? [] as Row[]
          : [{ id: this.existingDefinitionId }] as Row[]
      };
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
  test('reconciles equivalent built-ins before validating the combined owner scopes', async () => {
    const client = new InventoryClient();
    client.duplicateBuiltInDefinitions = true;
    const inventory = await new ProjectSpaceDatabaseRepository(client).listComputeInventory('user-one', {
      additionalOwnerUserIds: ['project-space:tailscale-deployment']
    });

    expect(inventory.environmentDefinitions.map(({ id }) => id)).toEqual(['definition-linux']);
    expect(inventory.environments.map(({ environmentDefinitionId }) => environmentDefinitionId))
      .toEqual(['definition-linux', 'definition-linux']);
    expect(inventory.violations).toEqual([]);
  });

  test('maps an owner-scoped inventory with no missing connector environments', async () => {
    const client = new InventoryClient();
    const repository = new ProjectSpaceDatabaseRepository(client);
    const inventory = await repository.listComputeInventory('user-one');
    expect(inventory.violations).toEqual([]);
    expect(inventory.connectors).toEqual([{
      associatedAt: '2026-08-08T00:00:00.000Z',
      connectorId: 'connector-one',
      environmentId: 'environment-one'
    }]);
    expect(inventory.environmentDefinitions).toEqual([{
      bootstrapStrategy: 'ssh',
      id: 'definition-linux',
      kind: 'native_linux',
      name: 'Linux',
      operatingSystemFamily: 'linux',
      ownership: 'built_in',
      slug: 'linux',
      supportedArchitectures: []
    }]);
    expect(inventory.environments[0]?.environmentDefinitionId).toBe('definition-linux');
    expect(inventory.environments[0]?.identityResolution).toBe('resolved');
    expect(client.calls.slice(0, 4).every(({ values }) => (
      JSON.stringify(values) === JSON.stringify([['user-one']])
    ))).toBe(true);
  });

  test('adds an explicit deployment infrastructure scope without widening connector ownership', async () => {
    const client = new InventoryClient();
    const repository = new ProjectSpaceDatabaseRepository(client);
    await repository.listComputeInventory('user-one', {
      additionalOwnerUserIds: ['project-space:tailscale-deployment']
    });

    for (const call of client.calls.slice(0, 4)) {
      expect(call.sql).toContain('owner_user_id = any($1::text[])');
      expect(call.values).toEqual([[
        'user-one',
        'project-space:tailscale-deployment'
      ]]);
    }
    expect(client.calls[4]?.sql).toContain('owner_user_id = $1');
    expect(client.calls[4]?.values).toEqual(['user-one']);
  });

  test('keeps same-ID deployment rows out of the strict Codex inventory boundary', async () => {
    const client = new InventoryClient();
    client.sameUuidAcrossOwners = true;
    const repository = new ProjectSpaceDatabaseRepository(client);
    const userInventory = await repository.listComputeInventory('user-one');
    const widenedInventory = await repository.listComputeInventory('user-one', {
      additionalOwnerUserIds: ['project-space:tailscale-deployment']
    });

    expect(userInventory.hosts.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'shared-host', name: 'User Host' }
    ]);
    expect(userInventory.environments.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'shared-environment', name: 'Ubuntu' }
    ]);
    expect(widenedInventory.hosts.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'shared-host', name: 'User Host' },
      { id: 'shared-host', name: 'Deployment Host' }
    ]);
    expect(widenedInventory.environments.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'shared-environment', name: 'Ubuntu' },
      { id: 'shared-environment', name: 'Deployment Environment' }
    ]);
    const inventoryQueries = client.calls.filter(({ sql }) => (
      sql.includes('from compute_hosts') || sql.includes('from compute_environments')
    ));
    expect(inventoryQueries.at(-2)?.values).toEqual([['user-one', 'project-space:tailscale-deployment']]);
    expect(inventoryQueries.at(-1)?.values).toEqual([['user-one', 'project-space:tailscale-deployment']]);
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
    const definitionInsert = client.calls.find(({ sql }) => (
      sql.includes('insert into compute_environment_definitions')
    ));
    expect(definitionInsert?.values.slice(2)).toEqual([
      'linux', 'Linux', 'native_linux', 'linux', [], 'ssh'
    ]);
    expect(environmentInsert?.values[6]).toMatch(/^account:[0-9a-f]{64}$/);
    expect(environmentInsert?.values[6]).not.toContain(reported.environmentIdentity.key);
    expect(environmentInsert?.values[12]).toBeNull();
    expect(environmentInsert?.values[13]).toBe('definition-native_linux');
  });

  test('reuses the existing equivalent built-in definition ID', async () => {
    const client = new InventoryClient();
    client.existingDefinitionId = 'definition-existing';
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');

    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }]);

    const environmentInsert = client.calls.find(({ sql }) => sql.includes('insert into compute_environments'));
    expect(environmentInsert?.values[13]).toBe('definition-existing');
  });

  test.each([
    'name',
    'operating_system_family',
    'supported_architectures',
    'bootstrap_strategy'
  ] as const)('rejects a built-in definition with an incompatible %s', async (field) => {
    const client = new InventoryClient();
    client.incompatibleBuiltInFields = [field];
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');

    await expect(repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }])).rejects.toThrow('The native_linux Environment definition could not be reconciled.');
  });

  test('suppresses only a tombstoned legacy projection and never reconciles it back', async () => {
    const client = new InventoryClient(); client.retiredConnector = true;
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');
    const inventory = await repository.listComputeInventory('user-one');
    expect(inventory.connectors).toEqual([]);
    expect(inventory.environments).toEqual([]);
    await repository.reconcileConnectorComputeInventory('user-one', [{ compute: reported, id: 'connector-one', name: 'connector-one' }]);
    expect(client.calls.some(({ sql }) => sql.includes('insert into compute_platforms'))).toBeFalse();
    expect(client.calls.some(({ sql }) => sql.includes('insert into connector_compute_environments'))).toBeFalse();
  });

  test('persists missing exclusive resources as SQL null', async () => {
    const client = new InventoryClient();
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');
    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: {
        ...reported,
        resourceMode: 'exclusive'
      },
      id: 'connector-one',
      name: 'connector-one'
    }]);

    const environmentInsert = client.calls.find(({ sql }) => sql.includes('insert into compute_environments'));
    expect(environmentInsert?.values[12]).toBeNull();
  });

  test('retains provider-bound environments while removing abandoned connector records', async () => {
    const client = new InventoryClient();
    const repository = new ProjectSpaceDatabaseRepository(client, () => 'new-id');
    await repository.reconcileConnectorComputeInventory('user-one', [{
      compute: reported,
      id: 'connector-one',
      name: 'connector-one'
    }]);

    const cleanup = client.calls.find(({ sql }) => sql.includes('delete from compute_environments'));
    expect(cleanup?.sql).toContain('from environment_provider_bindings binding');
    expect(cleanup?.sql).toContain('binding.environment_id = environment.id');
    expect(cleanup?.values).toEqual(['user-one', 'environment-reported']);
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
