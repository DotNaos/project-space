import { randomUUID } from 'node:crypto';

import type { DatabaseQueryClient } from '../database/client';
import type {
  AccessRouteRecord,
  PrivateNetworkInventory,
  PrivateNetworkRecord,
  SaveAccessRouteInput,
  SavePrivateNetworkInput
} from './contracts';
import {
  accessRouteCapabilities,
  accessRouteKinds,
  accessRoutePolicyStates,
  isCredentialReference,
  isPinnedSshHostKey,
  isPrivateAddress,
  isTargetIdentityRevision,
  privateNetworkApprovalStates,
  privateNetworkAvailabilityStates,
  privateNetworkProviderKinds,
  routeCapabilitiesMatchKind
} from './contracts';
import { capabilityRequiresInteractiveApproval } from './route-resolver';

interface PrivateNetworkRow {
  approval_state: PrivateNetworkRecord['approvalState'];
  availability: PrivateNetworkRecord['availability'];
  credential_reference: string | null;
  enabled: boolean;
  id: string;
  last_verified_at: Date | string | null;
  name: string;
  owner_user_id: string;
  provider_kind: PrivateNetworkRecord['providerKind'];
  provider_reference: string;
  verified_until: Date | string | null;
}

interface AccessRouteRow {
  allowed_gateway_ids: string[];
  availability: AccessRouteRecord['availability'];
  capabilities: AccessRouteRecord['capabilities'];
  credential_reference: string | null;
  credential_purpose: AccessRouteRecord['credentialPurpose'] | null;
  enabled: boolean;
  environment_id: string | null;
  freshness_seconds: number;
  host_id: string | null;
  id: string;
  last_verified_at: Date | string | null;
  owner_user_id: string;
  policy_state: AccessRouteRecord['policyState'];
  priority: number;
  private_address: string | null;
  private_network_id: string | null;
  provider_kind: AccessRouteRecord['providerKind'] | null;
  requires_interactive_approval: boolean;
  route_kind: AccessRouteRecord['routeKind'];
  ssh_host_key_sha256: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  target_identity_revision: string;
  verified_until: Date | string | null;
}

export interface PrivateNetworkStore {
  list(ownerUserId: string): Promise<PrivateNetworkInventory>;
  saveNetwork(ownerUserId: string, input: SavePrivateNetworkInput): Promise<PrivateNetworkRecord>;
  saveRoute(ownerUserId: string, input: SaveAccessRouteInput): Promise<AccessRouteRecord>;
  setNetworkApproval(ownerUserId: string, input: {
    approvalState: PrivateNetworkRecord['approvalState'];
    enabled: boolean;
    id: string;
  }): Promise<PrivateNetworkRecord | null>;
}

export class PostgresPrivateNetworkStore implements PrivateNetworkStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createId: () => string = randomUUID
  ) {}

  async list(ownerUserId: string): Promise<PrivateNetworkInventory> {
    const owner = required(ownerUserId, 'ownerUserId');
    const [networkResult, routeResult] = await Promise.all([
      this.client.query<PrivateNetworkRow>(
        `select id, owner_user_id, name, provider_kind, provider_reference,
                approval_state, enabled, availability, last_verified_at,
                verified_until, credential_reference
           from private_networks where owner_user_id = $1
          order by lower(name), id`,
        [owner]
      ),
      this.client.query<AccessRouteRow>(
        `select id, owner_user_id, environment_id, host_id, private_network_id,
                route_kind, provider_kind, capabilities, priority, enabled, policy_state,
                allowed_gateway_ids, requires_interactive_approval, availability,
                last_verified_at, verified_until, freshness_seconds,
                target_identity_revision, private_address, ssh_port, ssh_user,
                ssh_host_key_sha256, credential_reference, credential_purpose
           from access_routes where owner_user_id = $1
          order by priority desc, id`,
        [owner]
      )
    ]);
    return {
      networks: networkResult.rows.map(networkFromRow),
      routes: routeResult.rows.map(routeFromRow)
    };
  }

  async saveNetwork(ownerUserId: string, input: SavePrivateNetworkInput) {
    const owner = required(ownerUserId, 'ownerUserId');
    validateNetwork(input);
    const result = await this.client.query<PrivateNetworkRow>(
      `insert into private_networks (
         id, owner_user_id, name, provider_kind, provider_reference,
         approval_state, enabled, availability, last_verified_at,
         verified_until, credential_reference
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11)
       on conflict (owner_user_id, provider_kind, provider_reference) do update set
         availability = excluded.availability,
         last_verified_at = excluded.last_verified_at, verified_until = excluded.verified_until,
         updated_at = now()
       where private_networks.name = excluded.name and
             private_networks.approval_state = excluded.approval_state and
             private_networks.enabled = excluded.enabled and
             private_networks.credential_reference is not distinct from excluded.credential_reference and
             excluded.last_verified_at is not null and
             (private_networks.last_verified_at is null or
              excluded.last_verified_at > private_networks.last_verified_at)
       returning id, owner_user_id, name, provider_kind, provider_reference,
                 approval_state, enabled, availability, last_verified_at,
                 verified_until, credential_reference`,
      [this.createId(), owner, input.name.trim(), input.providerKind, input.providerReference.trim(),
        input.approvalState, input.enabled, input.availability,
        input.lastVerifiedAt ?? null, input.verifiedUntil ?? null,
        input.credentialReference ?? null]
    );
    let row = result.rows[0];
    if (!row) {
      const current = await this.client.query<PrivateNetworkRow>(
        `select id, owner_user_id, name, provider_kind, provider_reference,
                approval_state, enabled, availability, last_verified_at,
                verified_until, credential_reference
           from private_networks
          where owner_user_id = $1 and provider_kind = $2 and provider_reference = $3`,
        [owner, input.providerKind, input.providerReference.trim()]
      );
      row = current.rows[0];
    }
    if (!row) throw new Error('The private network could not be saved.');
    assertNetworkReplay(row, input);
    return networkFromRow(row);
  }

  async saveRoute(ownerUserId: string, input: SaveAccessRouteInput) {
    const owner = required(ownerUserId, 'ownerUserId');
    validateRoute(input);
    const environmentId = input.target.kind === 'environment' ? input.target.id : null;
    const hostId = input.target.kind === 'host' ? input.target.id : null;
    const capabilities = normalizeSet(input.capabilities);
    const allowedGatewayIds = normalizeSet(input.allowedGatewayIds);
    const result = await this.client.query<AccessRouteRow>(
      `insert into access_routes (
         id, owner_user_id, environment_id, host_id, private_network_id,
         route_kind, provider_kind, capabilities, priority, enabled, policy_state,
         allowed_gateway_ids, requires_interactive_approval, availability,
         last_verified_at, verified_until, freshness_seconds, target_identity_revision,
         private_address, ssh_port, ssh_user, ssh_host_key_sha256, credential_reference,
         credential_purpose
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12::text[], $13,
         $14, $15::timestamptz, $16::timestamptz, $17, $18, $19, $20, $21, $22, $23, $24
       ) on conflict (id, owner_user_id) do update set
         availability = excluded.availability, last_verified_at = excluded.last_verified_at,
         verified_until = excluded.verified_until, private_address = excluded.private_address,
         updated_at = now()
       where access_routes.environment_id is not distinct from excluded.environment_id and
             access_routes.host_id is not distinct from excluded.host_id and
             access_routes.private_network_id is not distinct from excluded.private_network_id and
             access_routes.route_kind = excluded.route_kind and
             access_routes.provider_kind is not distinct from excluded.provider_kind and
             access_routes.capabilities = excluded.capabilities and
             access_routes.priority = excluded.priority and
             access_routes.enabled = excluded.enabled and
             access_routes.policy_state = excluded.policy_state and
             access_routes.allowed_gateway_ids = excluded.allowed_gateway_ids and
             access_routes.requires_interactive_approval = excluded.requires_interactive_approval and
             access_routes.freshness_seconds = excluded.freshness_seconds and
             access_routes.target_identity_revision = excluded.target_identity_revision and
             access_routes.ssh_port is not distinct from excluded.ssh_port and
             access_routes.ssh_user is not distinct from excluded.ssh_user and
             access_routes.ssh_host_key_sha256 is not distinct from excluded.ssh_host_key_sha256 and
             access_routes.credential_reference is not distinct from excluded.credential_reference and
             access_routes.credential_purpose is not distinct from excluded.credential_purpose and
             excluded.last_verified_at is not null and
             (access_routes.last_verified_at is null or
              excluded.last_verified_at > access_routes.last_verified_at)
       returning id, owner_user_id, environment_id, host_id, private_network_id,
                 route_kind, provider_kind, capabilities, priority, enabled, policy_state,
                 allowed_gateway_ids, requires_interactive_approval, availability,
                 last_verified_at, verified_until, freshness_seconds, target_identity_revision,
                 private_address, ssh_port, ssh_user, ssh_host_key_sha256, credential_reference,
                 credential_purpose`,
      [input.id.trim(), owner, environmentId, hostId, input.privateNetworkId ?? null,
        input.routeKind, input.providerKind ?? null, capabilities, input.priority,
        input.enabled, input.policyState, allowedGatewayIds,
        input.requiresInteractiveApproval, input.availability, input.lastVerifiedAt ?? null,
        input.verifiedUntil ?? null, input.freshnessSeconds, input.targetIdentityRevision,
        input.privateAddress ?? null, input.sshPort ?? null, input.sshUser ?? null,
        input.hostKeySha256 ?? null, input.credentialReference ?? null,
        input.credentialPurpose ?? null]
    );
    let row = result.rows[0];
    if (!row) {
      const current = await this.client.query<AccessRouteRow>(
        `select id, owner_user_id, environment_id, host_id, private_network_id,
                route_kind, provider_kind, capabilities, priority, enabled, policy_state,
                allowed_gateway_ids, requires_interactive_approval, availability,
                last_verified_at, verified_until, freshness_seconds, target_identity_revision,
                private_address, ssh_port, ssh_user, ssh_host_key_sha256, credential_reference,
                credential_purpose
           from access_routes where id = $1 and owner_user_id = $2`,
        [input.id.trim(), owner]
      );
      row = current.rows[0];
    }
    if (!row) throw new Error('The access route could not be saved.');
    assertRouteReplay(row, input);
    return routeFromRow(row);
  }

  async setNetworkApproval(ownerUserId: string, input: {
    approvalState: PrivateNetworkRecord['approvalState'];
    enabled: boolean;
    id: string;
  }) {
    const owner = required(ownerUserId, 'ownerUserId');
    if (!isUuid(input.id) || !privateNetworkApprovalStates.includes(input.approvalState)) {
      throw new Error('The private-network approval is invalid.');
    }
    const result = await this.client.query<PrivateNetworkRow>(
      `update private_networks
          set approval_state = $3, enabled = $4, updated_at = now()
        where id = $1 and owner_user_id = $2
      returning id, owner_user_id, name, provider_kind, provider_reference,
                approval_state, enabled, availability, last_verified_at,
                verified_until, credential_reference`,
      [input.id, owner, input.approvalState, input.enabled]
    );
    return result.rows[0] ? networkFromRow(result.rows[0]) : null;
  }
}

function validateNetwork(input: SavePrivateNetworkInput) {
  required(input.name, 'name', 128);
  required(input.providerReference, 'providerReference', 256);
  if (!privateNetworkProviderKinds.includes(input.providerKind) ||
    !privateNetworkApprovalStates.includes(input.approvalState) ||
    !privateNetworkAvailabilityStates.includes(input.availability)) {
    throw new Error('The private network is invalid.');
  }
  if (input.credentialReference && !isCredentialReference(input.credentialReference)) {
    throw new Error('credentialReference must be an opaque 1Password reference.');
  }
  validateWindow(input.availability, input.lastVerifiedAt, input.verifiedUntil);
}

function validateRoute(input: SaveAccessRouteInput) {
  if (!isUuid(input.id) || !isUuid(input.target.id) ||
    input.privateNetworkId !== undefined && !isUuid(input.privateNetworkId)) {
    throw new Error('The access route uses an invalid opaque identifier.');
  }
  if (!accessRouteKinds.includes(input.routeKind) ||
    !accessRoutePolicyStates.includes(input.policyState) ||
    !privateNetworkAvailabilityStates.includes(input.availability) ||
    input.providerKind !== undefined && !privateNetworkProviderKinds.includes(input.providerKind) ||
    !isTargetIdentityRevision(input.targetIdentityRevision) || input.capabilities.length === 0 ||
    input.capabilities.some((capability) => !accessRouteCapabilities.includes(capability)) ||
    !routeCapabilitiesMatchKind(input.routeKind, input.capabilities) ||
    input.allowedGatewayIds.length > 64 ||
    input.allowedGatewayIds.some((gatewayId) => gatewayId !== gatewayId.trim() ||
      !/^[A-Za-z0-9:._-]{1,256}$/.test(gatewayId)) ||
    input.capabilities.some(capabilityRequiresInteractiveApproval) &&
      !input.requiresInteractiveApproval ||
    input.priority < 0 || input.priority > 1000 || input.freshnessSeconds < 1 ||
    input.freshnessSeconds > 86_400) throw new Error('The access route is invalid.');
  validateWindow(input.availability, input.lastVerifiedAt, input.verifiedUntil);
  if (input.routeKind === 'ssh_private_network' && (
    input.target.kind !== 'environment' || !input.privateNetworkId || !input.providerKind ||
    !input.privateAddress || !isPrivateAddress(input.privateAddress) || !input.sshPort ||
    input.sshPort < 1 || input.sshPort > 65_535 ||
    !input.sshUser || !/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(input.sshUser) ||
    !input.hostKeySha256 || !isPinnedSshHostKey(input.hostKeySha256) ||
    !input.credentialReference || !isCredentialReference(input.credentialReference)
  )) throw new Error('A private-network SSH route requires complete pinned configuration.');
  if (input.capabilities.includes('project_cli') && (
    input.routeKind !== 'ssh_private_network' ||
    input.credentialPurpose !== 'project_control_gateway_v1' ||
    input.capabilities.includes('interactive_shell')
  )) throw new Error('A Project CLI route requires an isolated control-gateway credential.');
}

function validateWindow(availability: string, lastVerifiedAt?: string, verifiedUntil?: string) {
  if (Boolean(lastVerifiedAt) !== Boolean(verifiedUntil) ||
    availability === 'available' && !lastVerifiedAt) throw new Error('Verification evidence is incomplete.');
  if (!lastVerifiedAt || !verifiedUntil) return;
  const start = Date.parse(lastVerifiedAt);
  const end = Date.parse(verifiedUntil);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('Verification evidence has an invalid window.');
  }
}

function assertNetworkReplay(row: PrivateNetworkRow, input: SavePrivateNetworkInput) {
  if (row.name !== input.name.trim() || row.provider_kind !== input.providerKind ||
    row.provider_reference !== input.providerReference.trim() ||
    row.approval_state !== input.approvalState || row.enabled !== input.enabled ||
    (row.credential_reference ?? undefined) !== input.credentialReference) {
    throw new Error('The private-network identity or configuration conflicts with its existing record.');
  }
  assertEvidenceReplay({
    current: {
      availability: row.availability,
      lastVerifiedAt: row.last_verified_at ? iso(row.last_verified_at) : undefined,
      verifiedUntil: row.verified_until ? iso(row.verified_until) : undefined
    },
    incoming: input,
    label: 'private-network'
  });
}

function assertRouteReplay(row: AccessRouteRow, input: SaveAccessRouteInput) {
  const current = routeFromRow(row);
  if (current.target.kind !== input.target.kind || current.target.id !== input.target.id ||
    current.privateNetworkId !== input.privateNetworkId || current.routeKind !== input.routeKind ||
    current.providerKind !== input.providerKind ||
    !sameSet(current.capabilities, input.capabilities) || current.priority !== input.priority ||
    current.enabled !== input.enabled || current.policyState !== input.policyState ||
    !sameSet(current.allowedGatewayIds, input.allowedGatewayIds) ||
    current.requiresInteractiveApproval !== input.requiresInteractiveApproval ||
    current.freshnessSeconds !== input.freshnessSeconds ||
    current.targetIdentityRevision !== input.targetIdentityRevision ||
    current.sshPort !== input.sshPort || current.sshUser !== input.sshUser ||
    current.hostKeySha256 !== input.hostKeySha256 ||
    current.credentialReference !== input.credentialReference ||
    current.credentialPurpose !== input.credentialPurpose) {
    throw new Error('The access-route identity or configuration conflicts with its existing record.');
  }
  assertEvidenceReplay({
    current,
    incoming: input,
    label: 'access-route',
    sameExtraEvidence: current.privateAddress === input.privateAddress
  });
}

function assertEvidenceReplay(input: {
  current: { availability: string; lastVerifiedAt?: string; verifiedUntil?: string };
  incoming: { availability: string; lastVerifiedAt?: string; verifiedUntil?: string };
  label: string;
  sameExtraEvidence?: boolean;
}) {
  if (!input.incoming.lastVerifiedAt) return;
  const currentTime = input.current.lastVerifiedAt
    ? Date.parse(input.current.lastVerifiedAt)
    : Number.NEGATIVE_INFINITY;
  const incomingTime = Date.parse(input.incoming.lastVerifiedAt);
  if (currentTime > incomingTime) return;
  if (currentTime === incomingTime && input.current.availability === input.incoming.availability &&
    input.current.verifiedUntil === input.incoming.verifiedUntil &&
    input.sameExtraEvidence !== false) return;
  if (currentTime < incomingTime) {
    throw new Error(`The ${input.label} evidence was not persisted.`);
  }
  throw new Error(`The ${input.label} observation conflicts with an existing replay.`);
}

function normalizeSet(values: readonly string[]) {
  return [...new Set(values.map((value) => value.trim()))].sort();
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return JSON.stringify(normalizeSet(left)) === JSON.stringify(normalizeSet(right));
}

function networkFromRow(row: PrivateNetworkRow): PrivateNetworkRecord {
  return {
    approvalState: row.approval_state,
    availability: row.availability,
    ...(row.credential_reference ? { credentialReference: row.credential_reference } : {}),
    enabled: row.enabled,
    id: row.id,
    ...(row.last_verified_at ? { lastVerifiedAt: iso(row.last_verified_at) } : {}),
    name: row.name,
    ownerUserId: row.owner_user_id,
    providerKind: row.provider_kind,
    providerReference: row.provider_reference,
    ...(row.verified_until ? { verifiedUntil: iso(row.verified_until) } : {})
  };
}

function routeFromRow(row: AccessRouteRow): AccessRouteRecord {
  return {
    allowedGatewayIds: row.allowed_gateway_ids,
    availability: row.availability,
    capabilities: row.capabilities,
    ...(row.credential_reference ? { credentialReference: row.credential_reference } : {}),
    ...(row.credential_purpose ? { credentialPurpose: row.credential_purpose } : {}),
    enabled: row.enabled,
    freshnessSeconds: row.freshness_seconds,
    ...(row.ssh_host_key_sha256 ? { hostKeySha256: row.ssh_host_key_sha256 } : {}),
    id: row.id,
    ...(row.last_verified_at ? { lastVerifiedAt: iso(row.last_verified_at) } : {}),
    ownerUserId: row.owner_user_id,
    policyState: row.policy_state,
    priority: row.priority,
    ...(row.private_address ? { privateAddress: row.private_address } : {}),
    ...(row.private_network_id ? { privateNetworkId: row.private_network_id } : {}),
    ...(row.provider_kind ? { providerKind: row.provider_kind } : {}),
    requiresInteractiveApproval: row.requires_interactive_approval,
    routeKind: row.route_kind,
    ...(row.ssh_port ? { sshPort: row.ssh_port } : {}),
    ...(row.ssh_user ? { sshUser: row.ssh_user } : {}),
    target: row.environment_id
      ? { id: row.environment_id, kind: 'environment' }
      : { id: row.host_id!, kind: 'host' },
    targetIdentityRevision: row.target_identity_revision,
    ...(row.verified_until ? { verifiedUntil: iso(row.verified_until) } : {})
  };
}

function required(value: string, field: string, maximumLength = 512) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\r\n]/.test(normalized)) {
    throw new Error(`${field} is required.`);
  }
  return normalized;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
