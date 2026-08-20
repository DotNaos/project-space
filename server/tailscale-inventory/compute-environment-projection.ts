import { createHash, randomUUID } from 'node:crypto';

import type { ComputeEnvironmentKind } from '../../src/shared/compute-environment-api';
import { builtInEnvironmentDefinition } from '../../src/shared/compute-environment-api';
import type { DatabaseQueryClient } from '../database/client';
import type { TailscaleDeviceClassification } from './contracts';

export class TailscaleEnvironmentInUse extends Error {
  constructor() {
    super('The Tailscale Environment still has Project Space references.');
    this.name = 'TailscaleEnvironmentInUse';
  }
}

interface ObservationRow { observed_name: string | null; os: string | null; }

export async function projectTailscaleClassification(
  client: DatabaseQueryClient,
  input: {
    classification: TailscaleDeviceClassification;
    deviceId: string;
    ownerUserId: string;
    revision: number;
  }
) {
  if (input.classification === 'environment') {
    const observation = await client.query<ObservationRow>(
      `select observed_name, os from tailscale_device_observations
        where owner_user_id = $1 and device_id = $2 for update`,
      [input.ownerUserId, input.deviceId]
    );
    const row = observation.rows[0];
    if (!row) throw new Error('The Tailscale observation disappeared during classification.');
    const kind = environmentKind(row.os);
    const platform = await client.query<{ id: string }>(
      `insert into compute_platforms (id, owner_user_id, kind, name)
       values ($1, $2, 'local', 'Local & self-hosted')
       on conflict (owner_user_id, kind, name) do update set updated_at = now()
       returning id`,
      [randomUUID(), input.ownerUserId]
    );
    const platformId = platform.rows[0]?.id;
    if (!platformId) throw new Error('The Local & self-hosted platform could not be reconciled.');
    const definitionId = await ensureDefinition(client, input.ownerUserId, kind);
    const environment = await client.query<{ id: string }>(
      `insert into compute_environments (
         id, owner_user_id, platform_id, environment_definition_id, identity_version, identity_key,
         kind, name, host_resolution, host_evidence, resource_mode
       ) values ($1, $2, $3, $4, 1, $5, $6, $7, 'unresolved', 'none', 'dedicated')
       on conflict (owner_user_id, platform_id, identity_version, identity_key) do update set
         environment_definition_id = excluded.environment_definition_id, kind = excluded.kind,
         name = excluded.name, updated_at = now()
       returning id`,
      [
        randomUUID(), input.ownerUserId, platformId, definitionId,
        accountScopedIdentity(input.ownerUserId, `tailscale-environment:${input.deviceId}`),
        kind, row.observed_name ?? 'Unnamed Tailscale environment'
      ]
    );
    const environmentId = environment.rows[0]?.id;
    if (!environmentId) throw new Error('The Tailscale Environment could not be reconciled.');
    await client.query(
      `insert into tailscale_compute_environment_projections (
         owner_user_id, device_id, environment_id, classification_revision
       ) values ($1, $2, $3, $4)
       on conflict (owner_user_id, device_id) do update set
         environment_id = excluded.environment_id,
         classification_revision = excluded.classification_revision,
         updated_at = now()`,
      [input.ownerUserId, input.deviceId, environmentId, input.revision]
    );
    return;
  }
  const projection = await client.query<{ environment_id: string }>(
    `select environment_id from tailscale_compute_environment_projections
      where owner_user_id = $1 and device_id = $2 for update`,
    [input.ownerUserId, input.deviceId]
  );
  const environmentId = projection.rows[0]?.environment_id;
  if (!environmentId) return;
  await client.query(
    `delete from tailscale_compute_environment_projections
      where owner_user_id = $1 and device_id = $2 and environment_id = $3`,
    [input.ownerUserId, input.deviceId, environmentId]
  );
  try {
    const deleted = await client.query<{ id: string }>(
      `delete from compute_environments environment
        where environment.owner_user_id = $1 and environment.id = $2 and environment.identity_key = $3
          and not exists (
            select 1 from tailscale_compute_environment_projections projection
             where projection.owner_user_id = environment.owner_user_id
               and projection.environment_id = environment.id
          )
        returning environment.id`,
      [input.ownerUserId, environmentId,
        accountScopedIdentity(input.ownerUserId, `tailscale-environment:${input.deviceId}`)]
    );
    if (!deleted.rows[0]) {
      throw new Error('The derived Tailscale Environment could not be safely removed.');
    }
  } catch (error) {
    if (postgresForeignKeyConflict(error)) throw new TailscaleEnvironmentInUse();
    throw error;
  }
}

/** Reconcile only a previously projected Environment after fresh provider evidence changes. */
export async function refreshTailscaleEnvironmentProjection(
  client: DatabaseQueryClient,
  ownerUserId: string,
  deviceId: string
) {
  const projection = await client.query<{ revision: number | string }>(
    `select classification.revision
       from tailscale_compute_environment_projections projection
       join tailscale_device_classifications classification
         on classification.owner_user_id = projection.owner_user_id
        and classification.device_id = projection.device_id
      where projection.owner_user_id = $1 and projection.device_id = $2
        and classification.classification = 'environment'
      for update of projection, classification`,
    [ownerUserId, deviceId]
  );
  const revision = Number(projection.rows[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) return;
  await projectTailscaleClassification(client, {
    classification: 'environment', deviceId, ownerUserId, revision
  });
}

function environmentKind(os: string | null): ComputeEnvironmentKind {
  switch (os?.trim().toLowerCase()) {
    case 'darwin': case 'macos': return 'native_macos';
    case 'windows': return 'native_windows';
    case 'wsl': return 'wsl';
    case 'linux': return 'native_linux';
    default: return 'other';
  }
}

async function ensureDefinition(
  client: DatabaseQueryClient,
  ownerUserId: string,
  kind: ComputeEnvironmentKind
) {
  const definition = builtInEnvironmentDefinition(kind);
  const result = await client.query<{ id: string }>(
    `insert into compute_environment_definitions (
       id, owner_user_id, slug, name, kind, operating_system_family,
       supported_architectures, bootstrap_strategy, ownership
     ) values ($1, $2, $3, $4, $5, $6, $7::text[], $8, 'built_in')
     on conflict (owner_user_id, slug) do update set updated_at = now()
       where compute_environment_definitions.ownership = 'built_in'
         and compute_environment_definitions.name = excluded.name
         and compute_environment_definitions.kind = excluded.kind
         and compute_environment_definitions.operating_system_family = excluded.operating_system_family
         and compute_environment_definitions.supported_architectures = excluded.supported_architectures
         and compute_environment_definitions.bootstrap_strategy = excluded.bootstrap_strategy
     returning id`,
    [randomUUID(), ownerUserId, definition.slug, definition.name, definition.kind,
      definition.operatingSystemFamily, definition.supportedArchitectures, definition.bootstrapStrategy]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('The Tailscale Environment definition could not be reconciled.');
  return id;
}

function accountScopedIdentity(ownerUserId: string, value: string) {
  return `account:${createHash('sha256').update(ownerUserId).update('\0').update(value).digest('hex')}`;
}

function postgresForeignKeyConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23503');
}
