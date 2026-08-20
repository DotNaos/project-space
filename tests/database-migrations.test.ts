import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import {
  databaseMigrations,
  migrationChecksum,
  runDatabaseMigrations
} from '../server/database/migrations';
import {
  codexMachineTasksMigrationId,
  codexMachineTasksMigrationSql
} from '../server/database/codex-machine-tasks-migration';
import {
  codexMachineTaskMessageDeliveryMigrationId,
  codexMachineTaskMessageDeliveryMigrationSql
} from '../server/database/codex-machine-task-message-delivery-migration';
import { computeInventoryMigrationSql } from '../server/database/compute-inventory-migration';
import {
  computeEnvironmentIdentityResolutionMigrationId,
  computeEnvironmentIdentityResolutionMigrationSql
} from '../server/database/compute-environment-identity-resolution-migration';
import {
  environmentCatalogMigrationId,
  environmentCatalogMigrationSql
} from '../server/database/environment-catalog-migration';
import {
  privateNetworkAccessRoutesMigrationId,
  privateNetworkAccessRoutesMigrationSql
} from '../server/database/private-network-access-routes-migration';
import {
  sshControlGatewayMigrationId,
  sshControlGatewayMigrationSql
} from '../server/database/ssh-control-gateway-migration';
import {
  workspaceRuntimeControlMigrationId,
  workspaceRuntimeControlMigrationSql
} from '../server/database/workspace-runtime-control-migration';
import {
  workspaceRuntimeSessionMigrationId,
  workspaceRuntimeSessionMigrationSql
} from '../server/database/workspace-runtime-session-migration';
import {
  projectHostdMigrationId,
  projectHostdMigrationSql
} from '../server/database/project-hostd-migration';
import {
  hostControlMigrationId,
  hostControlMigrationSql
} from '../server/database/host-control-migration';
import {
  hostControlHardeningMigrationId,
  hostControlHardeningMigrationSql
} from '../server/database/host-control-hardening-migration';
import {
  workspaceRuntimeCapabilityPromotionMigrationId,
  workspaceRuntimeCapabilityPromotionMigrationSql
} from '../server/database/workspace-runtime-capability-promotion-migration';
import {
  connectorCompatibilityUsageMigrationId,
  connectorCompatibilityUsageMigrationSql
} from '../server/database/connector-compatibility-usage-migration';
import {
  canonicalRuntimeControlMigrationId,
  canonicalRuntimeControlMigrationSql
} from '../server/database/canonical-runtime-control-migration';
import {
  canonicalRuntimeMutationMigrationId,
  canonicalRuntimeMutationMigrationSql
} from '../server/database/canonical-runtime-mutation-migration';
import {
  workspaceRuntimePresentationMigrationId,
  workspaceRuntimePresentationMigrationSql
} from '../server/database/workspace-runtime-presentation-migration';
import {
  tailscaleInventoryMigrationId,
  tailscaleInventoryMigrationSql
} from '../server/database/tailscale-inventory-migration';
import {
  infisicalCredentialReferencesMigrationId,
  infisicalCredentialReferencesMigrationSql
} from '../server/database/infisical-credential-references-migration';
import {
  tailscaleProviderConnectionMigrationId,
  tailscaleProviderConnectionMigrationSql
} from '../server/database/tailscale-provider-connection-migration';
import {
  tailscaleProviderConnectionRetirementMigrationId,
  tailscaleProviderConnectionRetirementMigrationSql
} from '../server/database/tailscale-provider-connection-retirement-migration';
import {
  legacyConnectorRemovalMigrationId,
  legacyConnectorRemovalMigrationSql
} from '../server/database/legacy-connector-removal-migration';
import {
  environmentDefinitionReconciliationMigrationId,
  environmentDefinitionReconciliationMigrationSql
} from '../server/database/environment-definition-reconciliation-migration';
import {
  tailscaleEnvironmentOwnershipMigrationId,
  tailscaleEnvironmentOwnershipMigrationSql
} from '../server/database/tailscale-environment-ownership-migration';

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

class MigrationTestClient implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];
  readonly applied = new Map<string, string>();

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });

    if (sql.includes('select id, checksum') && sql.includes('project_space_schema_migrations')) {
      return {
        rows: [...this.applied].map(([id, checksum]) => ({
          id,
          checksum
        })) as Row[]
      };
    }

    if (sql.includes('insert into project_space_schema_migrations')) {
      this.applied.set(String(values[0]), String(values[1]));
    }

    return { rows: [] as Row[] };
  }
}

describe('database migrations', () => {
  test('separates Tailscale observations, classifications, and safe audit history', () => {
    expect(tailscaleInventoryMigrationId).toBe('0053_tailscale_inventory');
    expect(tailscaleInventoryMigrationSql).toContain(
      'create table tailscale_device_observations'
    );
    expect(tailscaleInventoryMigrationSql).toContain(
      'create table tailscale_device_classifications'
    );
    expect(tailscaleInventoryMigrationSql).toContain(
      'create table tailscale_device_classification_audits'
    );
    expect(tailscaleInventoryMigrationSql).toContain(
      'primary key (owner_user_id, device_id)'
    );
    expect(tailscaleInventoryMigrationSql).toContain('addresses inet[]');
    expect(tailscaleInventoryMigrationSql).toContain('fresh_until timestamptz not null');
    expect(tailscaleInventoryMigrationSql).toContain('tailscale_compute_environment_projections');
    expect(tailscaleInventoryMigrationSql).toContain('classification_revision integer not null');
    expect(tailscaleInventoryMigrationSql).not.toContain('credential');
    expect(databaseMigrations.at(-7)?.id).toBe(tailscaleInventoryMigrationId);
  });

  test('fails closed on retired 1Password references and permits only environment names', () => {
    expect(infisicalCredentialReferencesMigrationId).toBe(
      '0054_infisical_credential_references'
    );
    expect(infisicalCredentialReferencesMigrationSql).toContain(
      "where credential_reference like 'op://%'"
    );
    expect(infisicalCredentialReferencesMigrationSql).toContain("policy_state = 'blocked'");
    expect(infisicalCredentialReferencesMigrationSql).toContain(
      "credential_reference ~ '^env://[A-Z_][A-Z0-9_]{0,127}$'"
    );
    expect(databaseMigrations.at(-6)?.id).toBe(infisicalCredentialReferencesMigrationId);
  });

  test('adds account-scoped Tailscale provider credentials without auditing secrets', () => {
    expect(tailscaleProviderConnectionMigrationId).toBe('0055_tailscale_provider_connections');
    expect(tailscaleProviderConnectionMigrationSql).toContain(
      'create table tailscale_provider_connections'
    );
    expect(tailscaleProviderConnectionMigrationSql).toContain('unique (owner_user_id)');
    expect(tailscaleProviderConnectionMigrationSql).toContain(
      "state in ('active', 'revoked')"
    );
    expect(tailscaleProviderConnectionMigrationSql).toContain('credential_ciphertext text');
    expect(tailscaleProviderConnectionMigrationSql).toContain(
      'create table tailscale_provider_connection_audits'
    );
    const auditSql = tailscaleProviderConnectionMigrationSql.slice(
      tailscaleProviderConnectionMigrationSql.indexOf('create table tailscale_provider_connection_audits')
    );
    expect(auditSql).not.toMatch(/credential|ciphertext|client_secret|token|raw_error/i);
    expect(databaseMigrations.at(-5)?.id).toBe(tailscaleProviderConnectionMigrationId);
  });

  test('retires and clears every legacy per-user Tailscale credential', () => {
    expect(tailscaleProviderConnectionRetirementMigrationId).toBe(
      '0056_tailscale_provider_connection_retirement'
    );
    expect(tailscaleProviderConnectionRetirementMigrationSql).toContain(
      "set state = 'revoked'"
    );
    for (const column of [
      'credential_key_id',
      'credential_ciphertext',
      'credential_iv',
      'credential_tag'
    ]) {
      expect(tailscaleProviderConnectionRetirementMigrationSql).toContain(`${column} = null`);
    }
    expect(tailscaleProviderConnectionRetirementMigrationSql).toContain(
      "'project-space:migration:0056', 'revoked'"
    );
    expect(databaseMigrations.at(-4)?.id).toBe(
      tailscaleProviderConnectionRetirementMigrationId
    );
  });

  test('adds Environment definitions and backfills every concrete instance', () => {
    expect(environmentCatalogMigrationId).toBe('0039_environment_catalog');
    expect(environmentCatalogMigrationSql).toContain(
      'create table compute_environment_definitions'
    );
    expect(environmentCatalogMigrationSql).toContain(
      'add column environment_definition_id uuid'
    );
    expect(environmentCatalogMigrationSql).toContain(
      'alter column environment_definition_id set not null'
    );
    expect(environmentCatalogMigrationSql).toContain(
      'foreign key (environment_definition_id, owner_user_id)'
    );
    expect(environmentCatalogMigrationSql).toContain(
      'create or replace function project_space_ensure_connector_environment()'
    );
  });

  test('reconciles only equivalent same-scope built-ins and preserves ambiguity', () => {
    expect(environmentDefinitionReconciliationMigrationId)
      .toBe('0058_environment_definition_reconciliation');
    expect(environmentDefinitionReconciliationMigrationSql).toContain(
      'compute_environment_definitions_built_in_slug_unique'
    );
    expect(environmentDefinitionReconciliationMigrationSql).toContain(
      'Conflicting built-in Environment definitions'
    );
    expect(environmentDefinitionReconciliationMigrationSql).toContain(
      'update compute_environments'
    );
    expect(environmentDefinitionReconciliationMigrationSql).toMatch(
      /environment_definition_id in \(\s*select id[\s\S]*?and ownership = 'built_in'[\s\S]*?and id <> duplicate\.canonical_id/
    );
    expect(environmentDefinitionReconciliationMigrationSql).toMatch(
      /delete from compute_environment_definitions[\s\S]*?and ownership = 'built_in'[\s\S]*?and id <> duplicate\.canonical_id/
    );
    expect(environmentDefinitionReconciliationMigrationSql).toContain(
      'returning id into definition_id_value'
    );
    expect(environmentDefinitionReconciliationMigrationSql).toContain(
      'The built-in Environment definition for owner % and slug % is conflicting'
    );
    expect(databaseMigrations.at(-2)?.id).toBe(environmentDefinitionReconciliationMigrationId);
  });

  test('backfills only one owner-scoped Tailscale Environment to one exact Host', () => {
    expect(tailscaleEnvironmentOwnershipMigrationId)
      .toBe('0059_tailscale_environment_ownership');
    expect(tailscaleEnvironmentOwnershipMigrationSql).toContain(
      'project_space_tailscale_environment_candidates'
    );
    expect(tailscaleEnvironmentOwnershipMigrationSql).toContain(
      "projection.owner_user_id = 'project-space:tailscale-deployment'"
    );
    expect(tailscaleEnvironmentOwnershipMigrationSql).toContain(
      'having count(*) = 1'
    );
    expect(tailscaleEnvironmentOwnershipMigrationSql).toMatch(
      /select distinct\s+machine_connector\.connector_id as connector_id,\s+environment\.id as environment_id/
    );
    expect(tailscaleEnvironmentOwnershipMigrationSql).toContain(
      'physical_machine_connectors'
    );
    expect(tailscaleEnvironmentOwnershipMigrationSql).toContain(
      "existing_definition.ownership = 'user_defined'"
    );
    expect(tailscaleEnvironmentOwnershipMigrationSql).toContain(
      "host_resolution, host_evidence, resource_mode"
    );
    expect(databaseMigrations.at(-1)?.id).toBe(tailscaleEnvironmentOwnershipMigrationId);
  });

  test('keeps two matching connectors on one Host as two migration candidates', () => {
    const distinctCandidateColumns = tailscaleEnvironmentOwnershipMigrationSql.match(
      /select distinct([\s\S]*?)from tailscale_compute_environment_projections/
    )?.[1];

    expect(distinctCandidateColumns).toContain(
      'machine_connector.connector_id as connector_id'
    );
    expect(distinctCandidateColumns).toContain('host.id as host_id');
    expect(tailscaleEnvironmentOwnershipMigrationSql).toMatch(
      /group by environment_id\s+having count\(\*\) = 1/
    );
  });

  test('repairs compute-environment identity resolution after the original migration', () => {
    expect(computeEnvironmentIdentityResolutionMigrationId).toBe(
      '0031_compute_environment_identity_resolution'
    );
    expect(computeEnvironmentIdentityResolutionMigrationSql).toContain(
      'alter table compute_environments'
    );
    expect(computeEnvironmentIdentityResolutionMigrationSql).toContain(
      "identity_resolution text not null default 'resolved'"
    );
    expect(computeEnvironmentIdentityResolutionMigrationSql).toContain(
      "identity_resolution in ('resolved', 'conflict')"
    );
  });

  test('uses PostgreSQL-compatible identity length checks for compute inventory', () => {
    expect(computeInventoryMigrationSql).not.toContain('{8,256}');
    expect(
      computeInventoryMigrationSql.match(/char_length\(identity_key\) between 8 and 256/g)
    ).toHaveLength(2);
    expect(
      computeInventoryMigrationSql.match(/identity_key ~ '\^\[A-Za-z0-9:_-\]\+\$'/g)
    ).toHaveLength(2);
  });

  test('keeps private-network routes owner-scoped, typed, and private-only', () => {
    expect(privateNetworkAccessRoutesMigrationId).toBe('0040_private_network_access_routes');
    expect(privateNetworkAccessRoutesMigrationSql).toContain('create table private_networks');
    expect(privateNetworkAccessRoutesMigrationSql).toContain('create table access_routes');
    expect(privateNetworkAccessRoutesMigrationSql).toContain(
      'foreign key (private_network_id, owner_user_id, provider_kind)'
    );
    expect(privateNetworkAccessRoutesMigrationSql).toContain(
      'foreign key (environment_id, owner_user_id)'
    );
    expect(privateNetworkAccessRoutesMigrationSql).toContain(
      'check ((environment_id is null) <> (host_id is null))'
    );
    expect(privateNetworkAccessRoutesMigrationSql).toContain(
      "route_kind <> 'ssh_private_network'"
    );
    expect(privateNetworkAccessRoutesMigrationSql).toContain("private_address ~ '^100\\.(");
    expect(privateNetworkAccessRoutesMigrationSql).toContain("credential_reference ~ '^op://");
  });

  test('binds SSH gateway operations to one owner, Environment, route, and typed result', () => {
    expect(sshControlGatewayMigrationId).toBe('0041_ssh_control_gateway_operations');
    expect(sshControlGatewayMigrationSql).toContain('create table ssh_gateway_operations');
    expect(sshControlGatewayMigrationSql).toContain(
      'create unique index access_routes_ssh_credential_unique'
    );
    expect(sshControlGatewayMigrationSql).toContain(
      "credential_purpose = 'project_control_gateway_v1'"
    );
    expect(sshControlGatewayMigrationSql).toContain(
      'foreign key (route_id, owner_user_id, environment_id, route_kind, target_identity_revision)'
    );
    expect(sshControlGatewayMigrationSql).toContain("capability = 'project_cli'");
    expect(sshControlGatewayMigrationSql).toContain("operation = 'status.v1'");
    expect(sshControlGatewayMigrationSql).toContain(
      "safe_result->>'operationId' = operation_id"
    );
    expect(sshControlGatewayMigrationSql).toContain(
      "safe_result->>'targetIdentityRevision' = target_identity_revision"
    );
    expect(sshControlGatewayMigrationSql).toContain(
      "where state in ('reserved', 'dispatching', 'uncertain')"
    );
    expect(sshControlGatewayMigrationSql).toContain('reserved_until timestamptz');
    expect(sshControlGatewayMigrationSql).toContain('dispatch_lease_until timestamptz');
    expect(sshControlGatewayMigrationSql).toContain("'reservation_expired'");
    expect(sshControlGatewayMigrationSql).toContain("'reconciled_succeeded'");
    expect(sshControlGatewayMigrationSql).toContain('create table ssh_gateway_operation_events');
    const operationLedgerSql = sshControlGatewayMigrationSql
      .split('create table ssh_gateway_operations')[1]!
      .split('create unique index ssh_gateway_operations_unresolved_target_idx')[0]!;
    for (const secretField of [
      'private_address', 'ssh_user', 'host_key', 'credential_reference', 'stdout', 'stderr'
    ]) expect(operationLedgerSql).not.toContain(secretField);
    expect(workspaceRuntimeControlMigrationId).toBe('0042_workspace_runtime_control');
    expect(workspaceRuntimeControlMigrationSql).toContain(
      'drop constraint ssh_gateway_operations_operation_check'
    );
    expect(workspaceRuntimeControlMigrationSql).toContain(
      'ssh_gateway_operations_safe_result_v2_check'
    );
    expect(workspaceRuntimeControlMigrationSql).toContain('workspace-runtime.start.v1');
    expect(databaseMigrations.find((migration) => migration.id === sshControlGatewayMigrationId)?.id)
      .toBe(sshControlGatewayMigrationId);
  });

  test('binds hostd credentials and telemetry to one immutable owner target', () => {
    expect(projectHostdMigrationId).toBe('0046_project_hostd_telemetry');
    expect(projectHostdMigrationSql).toContain('create table project_hostd_devices');
    expect(projectHostdMigrationSql).toContain('create table project_hostd_credentials');
    expect(projectHostdMigrationSql).toContain('create table project_hostd_observations');
    expect(projectHostdMigrationSql).toContain('foreign key (environment_id, owner_user_id)');
    expect(projectHostdMigrationSql).toContain('foreign key (host_id, owner_user_id)');
    expect(projectHostdMigrationSql).toContain(
      'foreign key (owner_user_id, device_id, current_credential_id)'
    );
    expect(projectHostdMigrationSql).toContain('unique (owner_user_id, operation_id)');
    expect(projectHostdMigrationSql).toContain('unique (owner_user_id, device_id, sequence)');
    expect(projectHostdMigrationSql).toContain("retain_until timestamptz not null default now() + interval '24 hours'");
    expect(projectHostdMigrationSql).not.toContain(' token text');
    expect(databaseMigrations.find(({ id }) => id === projectHostdMigrationId)?.id)
      .toBe(projectHostdMigrationId);
  });

  test('durably binds Host control replay and audit evidence to one owner and Host', () => {
    expect(hostControlMigrationId).toBe('0047_host_control_operations');
    expect(migrationChecksum({ id: hostControlMigrationId, sql: hostControlMigrationSql })).toBe(
      '795b0f4ebef9b0091c8c760aa69c2a50f2240bbea1b8bb47ad3551e56072912f'
    );
    expect(hostControlMigrationSql).toContain('create table host_control_operations');
    expect(hostControlMigrationSql).toContain('primary key (owner_user_id, operation_id)');
    expect(hostControlMigrationSql).toContain('foreign key (host_id, owner_user_id)');
    expect(hostControlMigrationSql).toContain("actor_type text not null");
    expect(hostControlMigrationSql).toContain('result jsonb');
    expect(hostControlHardeningMigrationId).toBe('0048_host_control_hardening');
    expect(hostControlHardeningMigrationSql).toContain(
      'alter table host_control_operations rename to host_control_operations_v1_retained'
    );
    expect(hostControlHardeningMigrationSql).toContain('create table host_control_operations');
    expect(hostControlHardeningMigrationSql).toContain('attempt_id uuid not null');
    expect(hostControlMigrationSql).toContain(
      "state in ('reserved', 'completed', 'failed', 'rejected', 'uncertain')"
    );
    expect(hostControlHardeningMigrationSql).toContain('host_control_one_dispatch_per_host');
    expect(hostControlHardeningMigrationSql).toContain('policy_decision_id text not null');
    expect(hostControlHardeningMigrationSql).toContain('binding_revision text not null');
    expect(hostControlHardeningMigrationSql).toContain('result_message text check');
    expect(hostControlHardeningMigrationSql).toContain(
      "state in ('failed', 'uncertain') and result_code = 'provider_unavailable'"
    );
    expect(hostControlHardeningMigrationSql).not.toContain('result jsonb');
    expect(databaseMigrations.find(({ id }) => id === hostControlHardeningMigrationId)?.id)
      .toBe(hostControlHardeningMigrationId);
  });

  test('fences Workspace Runtime generations, credentials, sessions, and replay evidence', () => {
    expect(databaseMigrations.find((migration) => migration.id === workspaceRuntimeSessionMigrationId)?.id)
      .toBe(workspaceRuntimeSessionMigrationId);
    expect(workspaceRuntimeSessionMigrationSql).toContain(
      'create unique index workspace_runtime_generations_current_idx'
    );
    expect(workspaceRuntimeSessionMigrationSql).toContain(
      'where superseded_at is null'
    );
    expect(workspaceRuntimeSessionMigrationSql).toContain(
      'foreign key (environment_id, owner_user_id)'
    );
    expect(workspaceRuntimeSessionMigrationSql).toContain(
      'unique (owner_user_id, workspace_id, environment_id, generation, credential_id)'
    );
    expect(workspaceRuntimeSessionMigrationSql).toContain(
      'foreign key (owner_user_id, workspace_id, environment_id, generation, current_credential_id)'
    );
    expect(workspaceRuntimeSessionMigrationSql).toContain('token_hash text not null unique');
    expect(workspaceRuntimeSessionMigrationSql).toContain('operation_id text not null');
    expect(workspaceRuntimeSessionMigrationSql).toContain('unique (owner_user_id, operation_id)');
    expect(workspaceRuntimeSessionMigrationSql).not.toContain(' token text');
    expect(workspaceRuntimeSessionMigrationSql).not.toContain('runtime.codex.v1');
    expect(workspaceRuntimeCapabilityPromotionMigrationSql).toContain(
      "requested_capabilities <@ array['runtime.codex.v1']::text[]"
    );
    expect(databaseMigrations.find(({ id }) => (
      id === workspaceRuntimeCapabilityPromotionMigrationId
    ))?.id).toBe(workspaceRuntimeCapabilityPromotionMigrationId);
    expect(workspaceRuntimeSessionMigrationSql).toContain(
      'unique (owner_user_id, workspace_id, generation, sequence)'
    );
    expect(workspaceRuntimeSessionMigrationSql).toContain(
      'pg_column_size(safe_payload) <= 65536'
    );
  });

  test('durably binds canonical Runtime control to one owner and exact Runtime session', () => {
    expect(canonicalRuntimeControlMigrationId).toBe('0050_canonical_runtime_control_operations');
    expect(canonicalRuntimeControlMigrationSql).toContain(
      'add column last_control_command_sequence bigint not null default 0'
    );
    expect(canonicalRuntimeControlMigrationSql).toContain(
      'add column last_control_event_sequence bigint not null default 0'
    );
    expect(canonicalRuntimeControlMigrationSql).toContain(
      'create table canonical_runtime_control_operations'
    );
    expect(canonicalRuntimeControlMigrationSql).toContain(
      'primary key (owner_user_id, operation_id)'
    );
    expect(canonicalRuntimeControlMigrationSql).toContain(
      'foreign key (owner_user_id, workspace_id, environment_id, generation)'
    );
    expect(canonicalRuntimeControlMigrationSql).toContain(
      "state in ('reserved', 'dispatching', 'completed', 'failed', 'uncertain')"
    );
    expect(canonicalRuntimeControlMigrationSql).toContain(
      'canonical_runtime_control_command_sequence_idx'
    );
    expect(canonicalRuntimeControlMigrationSql).toContain('pg_column_size(safe_result) <= 262144');
    expect(canonicalRuntimeControlMigrationSql).not.toMatch(
      /password|credential_reference|private_key|request_body|stdout|stderr/i
    );
    expect(databaseMigrations.at(-10)?.id).toBe(canonicalRuntimeControlMigrationId);
  });

  test('extends canonical control additively with safe mutation replay and ownership fences', () => {
    expect(canonicalRuntimeMutationMigrationId).toBe('0051_canonical_runtime_mutations');
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      'drop constraint workspace_runtime_requested_capabilities_v2_check'
    );
    expect(canonicalRuntimeMutationMigrationSql).toContain("'runtime.mutation.v1'");
    expect(canonicalRuntimeMutationMigrationSql).toContain('add column safe_input jsonb');
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      "safe_input - array['expectedHead', 'operation', 'scope'] = '{}'::jsonb"
    );
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      "safe_input->>'expectedServerGeneration' ~ '^[A-Za-z0-9:._-]{1,256}$'"
    );
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      "add column access_mode text not null default 'read'"
    );
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      'canonical_runtime_control_one_unresolved_mutation_idx'
    );
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      "where access_mode = 'mutation' and state in ('reserved', 'dispatching', 'uncertain')"
    );
    expect(canonicalRuntimeMutationMigrationSql).not.toContain("'worktree.prepare'");
    expect(canonicalRuntimeMutationMigrationSql).toContain("'worktree.prepare.v1'");
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      'drop constraint ssh_gateway_operations_operation_v2_check'
    );
    expect(canonicalRuntimeMutationMigrationSql).toContain(
      'add constraint ssh_gateway_operations_operation_v3_check'
    );
    expect(databaseMigrations.at(-9)?.id).toBe(canonicalRuntimeMutationMigrationId);
  });

  test('stores only bounded Runtime presentation fields', () => {
    expect(databaseMigrations.at(-8)?.id).toBe(workspaceRuntimePresentationMigrationId);
    expect(workspaceRuntimePresentationMigrationSql).toContain('presentation_repository');
    expect(workspaceRuntimePresentationMigrationSql).toContain('presentation_task_number');
    expect(workspaceRuntimePresentationMigrationSql).not.toContain('presentation_task_title');
    expect(workspaceRuntimePresentationMigrationSql).not.toMatch(
      /local_path|branch|commit|credential|generation_id|session_id|stdout|stderr/i
    );
  });

  test('persists explicit Codex message delivery and durable queue state', () => {
    expect(databaseMigrations.find((migration) => (
      migration.id === codexMachineTaskMessageDeliveryMigrationId
    ))?.id).toBe(codexMachineTaskMessageDeliveryMigrationId);
    expect(codexMachineTaskMessageDeliveryMigrationSql).toContain(
      "state in ('pending', 'queued', 'completed', 'uncertain')"
    );
    expect(codexMachineTaskMessageDeliveryMigrationSql).toContain(
      "where state in ('pending', 'queued', 'uncertain')"
    );
    expect(codexMachineTaskMessageDeliveryMigrationSql).toContain('dispatch_attempt integer');
    expect(codexMachineTaskMessageDeliveryMigrationSql).toContain('request_fingerprint_sha256');
  });

  test('preserves the original machine-task migration and backfills durability conservatively', () => {
    expect(migrationChecksum({
      id: codexMachineTasksMigrationId,
      sql: codexMachineTasksMigrationSql
    })).toBe('7da3fce3e7e2b8a5915a605991e463b498392f2aacd2fc584414b475ccefbc06');
    const durability = databaseMigrations.find((migration) => (
      migration.id === '0022_codex_machine_task_durable_operations'
    ));
    expect(durability?.sql).toContain('set durable_operations = false');
    expect(durability?.sql).toContain('alter column durable_operations set not null');
  });

  test('defines the multi-user tables and their ownership constraints', () => {
    expect(databaseMigrations.map((migration) => migration.id)).toEqual([
      '0001_github_oauth_tokens',
      '0002_machine_memberships_and_run_settings',
      '0003_dev_server_sessions',
      '0004_connector_credentials',
      '0005_user_project_states',
      '0006_connector_credential_expected_machine',
      '0007_project_chat',
      '0008_machine_connections',
      '0009_project_chat_human_profiles',
      '0010_connector_machine_snapshots',
      '0011_github_catalog_cache',
      '0012_project_chat_name_registry',
      '0013_project_chat_project_channels',
      '0014_dev_server_sessions_per_server',
      '0015_connector_runtime_operations',
      '0016_codex_sessions',
      '0017_github_issue_creation_operations',
      '0018_connector_enrollment_profiles',
      '0019_machine_execution_scopes',
      '0020_physical_machines',
      '0021_codex_machine_tasks',
      '0022_codex_machine_task_durable_operations',
      '0023_codex_machine_task_start_payload',
      '0024_roadmap_plans',
      '0025_pr_dev_server_leases',
      '0026_machine_power_operations',
      '0027_project_chat_name_leases',
      '0028_codex_session_settings_operations',
      '0029_project_space_mcp_oauth',
      '0030_compute_inventory',
      '0031_compute_environment_identity_resolution',
      '0032_environment_lifecycle',
      '0033_agent_authorization_operations',
      '0034_task_execution_storage',
      '0035_task_handoff_artifacts',
      '0036_workspace_commands',
      '0037_task_delivery',
      '0038_dev_server_managed_states',
      '0039_environment_catalog',
      '0040_private_network_access_routes',
      '0041_ssh_control_gateway_operations',
      '0042_workspace_runtime_control',
      '0043_workspace_runtime_sessions',
      '0044_codex_machine_task_message_delivery',
      '0045_workspace_runtime_capability_promotions',
      '0046_project_hostd_telemetry',
      '0047_host_control_operations',
      '0048_host_control_hardening',
      '0049_connector_compatibility_usage',
      '0050_canonical_runtime_control_operations',
      '0051_canonical_runtime_mutations',
      '0052_workspace_runtime_presentation',
      '0053_tailscale_inventory',
      '0054_infisical_credential_references',
      '0055_tailscale_provider_connections',
      '0056_tailscale_provider_connection_retirement',
      '0057_legacy_connector_removal_receipts',
      '0058_environment_definition_reconciliation',
      '0059_tailscale_environment_ownership'
    ]);

    expect(connectorCompatibilityUsageMigrationId).toBe('0049_connector_compatibility_usage');
    expect(connectorCompatibilityUsageMigrationSql).toContain(
      'create table if not exists connector_compatibility_usage'
    );
    expect(connectorCompatibilityUsageMigrationSql).toContain(
      'create table if not exists connector_compatibility_observations'
    );
    expect(legacyConnectorRemovalMigrationId).toBe('0057_legacy_connector_removal_receipts');
    expect(legacyConnectorRemovalMigrationSql).toContain('legacy_connector_removal_receipts');
    expect(legacyConnectorRemovalMigrationSql).not.toContain('on delete cascade');
    expect(connectorCompatibilityUsageMigrationSql).toContain(
      "recorder_state text not null check (recorder_state in ('active', 'clean'))"
    );
    expect(connectorCompatibilityUsageMigrationSql).not.toMatch(
      /request_body|target_id|path|token|secret|content/i
    );

    const sql = databaseMigrations.map((migration) => migration.sql).join('\n');

    expect(sql).toContain('create table if not exists github_oauth_tokens');
    expect(sql).toContain('create table if not exists machine_memberships');
    expect(sql).toContain('create table project_chat_name_claims');
    expect(sql).toContain('name_lease_retired_at timestamptz');
    expect(sql).toContain(
      "update project_chat_name_claims\n    set updated_at = date_trunc('milliseconds', now())"
    );
    expect(sql).toContain('project_chat_name_claims_lease_expiry_idx');
    expect(sql).toContain('create table if not exists user_project_run_settings');
    expect(sql).toContain('allowed_hosts text[]');
    expect(sql).toContain('foreign key (machine_id, user_id)');
    expect(sql).toContain('on dev_server_sessions (machine_id, worktree_id, server_id)');
    expect(sql).toContain('drop index if exists dev_server_sessions_one_active_per_worktree');
    expect(sql).toContain('drop index if exists dev_server_sessions_one_active_per_server');
    expect(sql).toContain(
      "where state in ('starting', 'running', 'local-only', 'stopping')"
    );
    expect(sql).toContain('create table if not exists dev_server_sessions');
    expect(sql).toContain('foreign key (machine_id, owner_user_id)');
    expect(sql).toContain('create table machine_power_operations');
    expect(sql).toContain('create unique index machine_power_one_dispatch_per_machine');
    expect(sql).toContain('dispatch_attempted boolean not null default false');
    expect(sql).toContain("state in ('accepted', 'uncertain') and dispatch_attempted");
    expect(sql).toContain("'expired'");
    expect(sql).toContain("actor_type text not null");
    expect(sql).toContain("actor_type = 'machine'");
    expect(sql).toContain('caller_machine_id text');
    expect(sql).toContain('add column expected_machine_id text');
    expect(sql).toContain("'revoked-enrollment-' || id::text");
    expect(sql).toContain('alter column expected_machine_id set not null');
    expect(sql).toContain('connector_credentials_expected_machine_id_not_blank');
    expect(sql).toContain('connector_credentials_machine_matches_expected');
    expect(sql).toContain('create table connector_runtime_operations');
    expect(sql).toContain('connector_runtime_operations_one_active_per_machine');
    expect(sql).toContain('create table connector_runtime_audit_events');
    expect(sql).toContain("action = 'connector-runtime.maintenance-request'");
    expect(sql).toContain('connector_machine_snapshots');
    expect(sql).toContain('machine_connection_requests_connector_profile_pair');
    expect(sql).toContain('machine_identities_connector_profile_pair');
    expect(sql).toContain('connector_machine_snapshots_connector_profile_pair');
    expect(sql).toContain('create table machine_execution_scopes');
    expect(sql).toContain('create table machine_execution_scope_members');
    expect(sql).toContain('create table physical_machines');
    expect(sql).toContain('create table physical_machine_connectors');
    expect(sql).toContain('create table compute_platforms');
    expect(sql).toContain('create table compute_hosts');
    expect(sql).toContain('create table compute_environments');
    expect(sql).toContain('create table connector_compute_environments');
    expect(sql).toContain('machine_memberships_compute_environment');
    expect(sql).toContain('association_source');
    expect(sql).toContain('host_resolution');
    expect(sql).toContain('identity_resolution');
    expect(sql).toContain('create table environment_provider_bindings');
    expect(sql).toContain('create table environment_lifecycle_operations');
    expect(sql).toContain('environment_lifecycle_one_unresolved_per_scope');
    expect(sql).toContain('create table agent_authorization_operations');
    expect(sql).toContain('agent_authorization_one_unresolved_per_environment');
    expect(sql).toContain('create table task_handoffs');
    expect(sql).toContain('create table workspace_commands');
    expect(sql).toContain('create table task_deliveries');
    expect(sql).toContain('create table task_delivery_evidence');
    expect(sql).toContain('create table task_delivery_revision_reviews');
    expect(sql).toContain('runner_workspaces_target_check');
    expect(sql).toContain("scope in ('workspace', 'environment_recovery')");
    expect(sql).toContain('create table task_handoff_revisions');
    expect(sql).toContain('create table task_executions');
    expect(sql).toContain('create table task_execution_events');
    expect(sql).toContain('create table execution_operations');
    expect(sql).toContain('create table capacity_leases');
    expect(sql).toContain('primary key (owner_user_id, connector_id)');
    expect(sql).toContain('insert into physical_machines');
    expect(sql).toContain('from machine_execution_scopes');
    expect(sql).toContain('insert into physical_machine_connectors');
    expect(sql).toContain('from machine_execution_scope_members');
    expect(sql).toContain('create table if not exists codex_machine_task_starts');
    expect(sql).toContain('primary key (owner_user_id, association_key)');
    expect(sql).toContain('create table if not exists codex_machine_task_start_operations');
    expect(sql).toContain('primary key (owner_user_id, operation_id)');
    expect(sql).toContain('create table if not exists codex_machine_task_sends');
    expect(sql).toContain('codex_machine_task_sends_one_unresolved_per_thread');
    expect(sql).toContain('add column if not exists durable_operations boolean');
    expect(sql).toContain('set durable_operations = false');
    expect(sql).toContain('alter column durable_operations set not null');
    expect(sql).toContain('add column start_payload jsonb');
    expect(sql).toContain('references machine_memberships (machine_id, user_id)');
    expect(sql).toContain('registry jsonb not null');
    expect(sql).toContain('removed_by_user_id text');
    expect(sql).toContain('machine_id is null or machine_id = expected_machine_id');
    expect(sql).toContain('create table if not exists user_project_states');
    expect(sql).toContain('user_id text primary key');
    expect(sql).toContain('create table if not exists project_space_mcp_oauth_clients');
    expect(sql).toContain('create table if not exists project_space_mcp_oauth_authorizations');
    expect(sql).toContain('create table if not exists project_space_mcp_oauth_credentials');
    expect(sql).toContain("kind in ('authorization_code', 'access_token', 'refresh_token')");
    expect(sql).toContain('state jsonb not null');
    expect(sql).toContain('dev_server_sessions_one_active_per_worktree');
    expect(sql).toContain("where state in ('starting', 'running', 'stopping')");
    expect(sql).toContain('create table if not exists connector_credentials');
    expect(sql).toContain('token_hash text not null unique');
    expect(sql).toContain('machine_id text check');
    expect(sql).toContain('expires_at timestamptz not null');
    expect(sql).toContain('last_seen_at timestamptz');
    expect(sql).toContain('revoked_at timestamptz');
    expect(sql).toContain('foreign key (machine_id, owner_user_id)');
    expect(sql).toContain('create table if not exists project_chat_channels');
    expect(sql).toContain('create table if not exists project_chat_members');
    expect(sql).toContain('project_chat_members_space_actor_unique');
    expect(sql).toContain('project_chat_members_space_handle_unique');
    expect(sql).toContain('create table if not exists project_chat_messages');
    expect(sql).toContain('create table if not exists project_chat_message_mentions');
    expect(sql).toContain('create table if not exists project_chat_cursors');
    expect(sql).toContain('create table if not exists project_chat_idempotency');
    expect(sql).toContain('project_chat_idempotency_identity_unique');
    expect(sql).toContain('add column project_id text');
    expect(sql).toContain('project_chat_channels_scope_consistent');
    expect(sql).toContain('project_chat_channels_project_unique');
    expect(sql).toContain('create table project_chat_human_profiles');
    expect(sql).toContain('avatar_data_url_override text');
    expect(sql).toContain('revision bigint not null default 1');
    expect(sql).toContain('insert into project_chat_human_profiles');
    expect(sql).toContain('set profile_revision = 1');
    expect(sql).toContain('project_chat_members_profile_revision_positive');
    expect(sql).toContain('project_chat_members_role_origin_consistent');
    expect(sql).toContain("role = 'agent' and origin is not null and avatar_url is null");
    expect(sql).toContain('references project_chat_messages (space_id, id)');
    expect(sql).toContain('on delete cascade');
    expect(sql).toContain('create table machine_identities');
    expect(sql).toContain('create table machine_connection_requests');
    expect(sql).toContain('create table machine_connection_rate_events');
    expect(sql).toContain('machine_identities_current_credential_fk');
    expect(sql).toContain('create table if not exists github_catalog_cache');
    expect(sql).toContain('primary key (user_id, scope)');
    expect(sql).toContain('github_issue_creation_operations');
    expect(sql).toContain('primary key (owner_user_id, repository_full_name, operation_id)');
    expect(sql).toContain('create table roadmap_plans');
    expect(sql).toContain('create table roadmap_dependency_snapshots');
    expect(sql).toContain('primary key (repository_id, principal_id)');
    expect(sql).toContain('revision bigint not null default 0');
    expect(sql).toContain('create table pull_request_dev_server_leases');
    expect(sql).toContain('pull_request_dev_server_leases_current_scope_idx');
  });

  test('applies pending migrations once under a transaction and records checksums', async () => {
    const client = new MigrationTestClient();
    const alreadyApplied = databaseMigrations[0];
    client.applied.set(alreadyApplied.id, migrationChecksum(alreadyApplied));

    await runDatabaseMigrations(client);

    expect(client.calls[0]?.sql).toBe('begin');
    expect(client.calls.some((call) => call.sql.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(client.calls.some((call) => call.sql.includes('project_space_schema_migrations'))).toBe(
      true
    );
    expect(client.calls.some((call) => call.sql === alreadyApplied.sql)).toBe(false);
    expect(client.calls.some((call) => call.sql === databaseMigrations[1].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[2].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[3].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[4].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[5].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[6].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[7].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[8].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[9].sql)).toBe(true);
    expect(client.calls.some((call) => call.sql === databaseMigrations[10].sql)).toBe(true);
    expect(client.calls.at(-1)?.sql).toBe('commit');
    expect(client.applied).toEqual(
      new Map(databaseMigrations.map((migration) => [migration.id, migrationChecksum(migration)]))
    );

    const firstRunCallCount = client.calls.length;
    await runDatabaseMigrations(client);

    const secondRunCalls = client.calls.slice(firstRunCallCount);
    expect(
      secondRunCalls.some((call) =>
        databaseMigrations.some((migration) => migration.sql === call.sql)
      )
    ).toBe(false);
  });

  test('rolls back when an applied migration was modified', async () => {
    const client = new MigrationTestClient();
    client.applied.set(databaseMigrations[0].id, 'unexpected-checksum');

    await expect(runDatabaseMigrations(client)).rejects.toThrow(
      'Database migration 0001_github_oauth_tokens changed after it was applied.'
    );
    expect(client.calls.at(-1)?.sql).toBe('rollback');
  });
});
