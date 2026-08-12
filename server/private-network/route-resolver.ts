import type {
  AccessRouteAuthorization,
  AccessRouteCapability,
  AccessRouteEligibilityState,
  AccessRouteRecord,
  AuthorizedAccessRouteSelection,
  PrivateNetworkRecord
} from './contracts';
import {
  isCredentialReference,
  isPinnedSshHostKey,
  isPrivateAddress,
  routeCapabilitiesMatchKind
} from './contracts';

export type AccessRouteSelectionResult =
  | { reason: 'authorization_denied' | 'no_route'; state: 'blocked' }
  | { candidates: string[]; reason: 'ambiguous'; state: 'blocked' }
  | { route: AuthorizedAccessRouteSelection; state: 'ready' };

export async function selectAuthorizedAccessRoute(input: {
  authorization: AccessRouteAuthorization;
  explicitRouteId?: string;
  loadCandidates: () => Promise<{
    networks: readonly PrivateNetworkRecord[];
    routes: readonly AccessRouteRecord[];
  }>;
  now?: Date;
}): Promise<AccessRouteSelectionResult> {
  const now = input.now ?? new Date();
  if (!authorizationIsCurrent(input.authorization, now)) {
    return { reason: 'authorization_denied', state: 'blocked' };
  }
  const loaded = await input.loadCandidates();
  const networks = new Map(loaded.networks.map((network) => [network.id, network]));
  const bound = loaded.routes.filter((route) => route.ownerUserId === input.authorization.ownerUserId &&
    route.target.kind === input.authorization.target.kind &&
    route.target.id === input.authorization.target.id);
  const considered = input.explicitRouteId
    ? bound.filter((route) => route.id === input.explicitRouteId)
    : bound;
  const eligible = considered.filter((route) => routeEligibility({
    authorization: input.authorization,
    network: route.privateNetworkId ? networks.get(route.privateNetworkId) : undefined,
    now,
    route
  }) === 'ready');
  if (eligible.length === 0) return { reason: 'no_route', state: 'blocked' };
  if (input.explicitRouteId) return { route: selection(eligible[0]!), state: 'ready' };
  const priority = Math.max(...eligible.map((route) => route.priority));
  const preferred = eligible.filter((route) => route.priority === priority)
    .sort((left, right) => left.id.localeCompare(right.id));
  if (preferred.length !== 1) {
    return { candidates: preferred.map((route) => route.id), reason: 'ambiguous', state: 'blocked' };
  }
  return { route: selection(preferred[0]!), state: 'ready' };
}

export function routeEligibility(input: {
  authorization: AccessRouteAuthorization;
  network?: PrivateNetworkRecord;
  now: Date;
  route: AccessRouteRecord;
}): AccessRouteEligibilityState {
  const { authorization, network, now, route } = input;
  const evidenceState = routeEvidenceState({
    network,
    now,
    route,
    targetIdentityRevision: authorization.target.identityRevision
  });
  if (evidenceState !== 'ready') return evidenceState;
  if (route.ownerUserId !== authorization.ownerUserId ||
    route.target.kind !== authorization.target.kind || route.target.id !== authorization.target.id ||
    !route.capabilities.includes(authorization.capability) ||
    !route.allowedGatewayIds.includes(authorization.gatewayId) ||
    (route.requiresInteractiveApproval ||
      capabilityRequiresInteractiveApproval(authorization.capability)) &&
      authorization.risk === 'normal') {
    return 'policy_blocked';
  }
  return 'ready';
}

export function routeEvidenceState(input: {
  network?: PrivateNetworkRecord;
  now: Date;
  route: AccessRouteRecord;
  targetIdentityRevision: string;
}): AccessRouteEligibilityState {
  const { network, now, route, targetIdentityRevision } = input;
  if (!route.enabled || route.availability === 'unavailable') return 'unavailable';
  if (route.policyState !== 'approved' ||
    route.targetIdentityRevision !== targetIdentityRevision ||
    route.allowedGatewayIds.length === 0 ||
    !routeCapabilitiesMatchKind(route.routeKind, route.capabilities)) return 'policy_blocked';
  if (route.availability === 'unknown' || !route.lastVerifiedAt || !route.verifiedUntil) {
    return 'unverified';
  }
  if (!freshWindow(route.lastVerifiedAt, route.verifiedUntil, route.freshnessSeconds, now)) {
    return 'stale';
  }
  if (route.routeKind === 'ssh_private_network') {
    if (!network || network.ownerUserId !== route.ownerUserId || !network.enabled ||
      network.approvalState !== 'approved' || network.providerKind !== route.providerKind) {
      return 'policy_blocked';
    }
    if (network.availability === 'unavailable') return 'unavailable';
    if (network.availability === 'unknown') return 'unverified';
    if (!network.lastVerifiedAt || !network.verifiedUntil ||
      !freshWindow(network.lastVerifiedAt, network.verifiedUntil, route.freshnessSeconds, now)) {
      return 'stale';
    }
    if (!route.privateAddress || !isPrivateAddress(route.privateAddress) ||
      !route.sshPort || !route.sshUser || !route.hostKeySha256 ||
      !isPinnedSshHostKey(route.hostKeySha256) || !route.credentialReference ||
      !isCredentialReference(route.credentialReference)) return 'policy_blocked';
  }
  return 'ready';
}

function authorizationIsCurrent(authorization: AccessRouteAuthorization, now: Date) {
  const expiresAt = Date.parse(authorization.expiresAt);
  return authorization.allowed && Number.isFinite(expiresAt) && expiresAt > now.getTime() &&
    authorization.ownerUserId.length > 0 && authorization.gatewayId.length > 0 &&
    authorization.target.id.length > 0 && authorization.target.identityRevision.length > 0;
}

function freshWindow(start: string, end: string, freshnessSeconds: number, now: Date) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= now.getTime() &&
    endMs > now.getTime() && endMs >= startMs &&
    now.getTime() - startMs <= freshnessSeconds * 1000;
}

function selection(route: AccessRouteRecord): AuthorizedAccessRouteSelection {
  return {
    ...(route.credentialReference ? { credentialReference: route.credentialReference } : {}),
    ...(route.credentialPurpose ? { credentialPurpose: route.credentialPurpose } : {}),
    ...(route.hostKeySha256 ? { hostKeySha256: route.hostKeySha256 } : {}),
    ownerUserId: route.ownerUserId,
    ...(route.privateAddress ? { privateAddress: route.privateAddress } : {}),
    ...(route.privateNetworkId ? { privateNetworkId: route.privateNetworkId } : {}),
    routeId: route.id,
    routeKind: route.routeKind,
    ...(route.sshPort ? { sshPort: route.sshPort } : {}),
    ...(route.sshUser ? { sshUser: route.sshUser } : {}),
    target: route.target,
    targetIdentityRevision: route.targetIdentityRevision
  };
}

export function capabilityRequiresInteractiveApproval(capability: AccessRouteCapability) {
  return ['interactive_shell', 'host_console', 'host_power'].includes(capability);
}
