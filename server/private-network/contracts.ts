import { isIP } from 'node:net';

export type PrivateNetworkProviderKind = 'tailscale' | 'wireguard' | 'other';
export type PrivateNetworkApprovalState = 'approved' | 'pending' | 'revoked';
export type PrivateNetworkAvailability = 'available' | 'unavailable' | 'unknown';

export type AccessRouteKind =
  | 'ssh_private_network'
  | 'provider_native'
  | 'host_console'
  | 'hostd';

export type AccessRouteCapability =
  | 'project_cli'
  | 'interactive_shell'
  | 'provider_exec'
  | 'host_console'
  | 'host_power'
  | 'hostd_telemetry';

export type AccessRoutePolicyState = 'approved' | 'blocked' | 'unknown';

export const privateNetworkProviderKinds: readonly PrivateNetworkProviderKind[] = [
  'tailscale', 'wireguard', 'other'
];
export const privateNetworkApprovalStates: readonly PrivateNetworkApprovalState[] = [
  'approved', 'pending', 'revoked'
];
export const privateNetworkAvailabilityStates: readonly PrivateNetworkAvailability[] = [
  'available', 'unavailable', 'unknown'
];
export const accessRouteKinds: readonly AccessRouteKind[] = [
  'ssh_private_network', 'provider_native', 'host_console', 'hostd'
];
export const accessRouteCapabilities: readonly AccessRouteCapability[] = [
  'project_cli', 'interactive_shell', 'provider_exec',
  'host_console', 'host_power', 'hostd_telemetry'
];
export const accessRoutePolicyStates: readonly AccessRoutePolicyState[] = [
  'approved', 'blocked', 'unknown'
];

export interface PrivateNetworkRecord {
  approvalState: PrivateNetworkApprovalState;
  availability: PrivateNetworkAvailability;
  credentialReference?: string;
  enabled: boolean;
  id: string;
  lastVerifiedAt?: string;
  name: string;
  ownerUserId: string;
  providerKind: PrivateNetworkProviderKind;
  providerReference: string;
  verifiedUntil?: string;
}

export interface AccessRouteTarget {
  id: string;
  kind: 'environment' | 'host';
}

export interface AccessRouteRecord {
  allowedGatewayIds: readonly string[];
  availability: PrivateNetworkAvailability;
  capabilities: readonly AccessRouteCapability[];
  credentialReference?: string;
  enabled: boolean;
  freshnessSeconds: number;
  hostKeySha256?: string;
  id: string;
  lastVerifiedAt?: string;
  ownerUserId: string;
  policyState: AccessRoutePolicyState;
  priority: number;
  privateAddress?: string;
  privateNetworkId?: string;
  providerKind?: PrivateNetworkProviderKind;
  requiresInteractiveApproval: boolean;
  routeKind: AccessRouteKind;
  sshPort?: number;
  sshUser?: string;
  target: AccessRouteTarget;
  targetIdentityRevision: string;
  verifiedUntil?: string;
}

export interface PrivateNetworkInventory {
  networks: readonly PrivateNetworkRecord[];
  routes: readonly AccessRouteRecord[];
}

export interface SavePrivateNetworkInput {
  approvalState: PrivateNetworkApprovalState;
  availability: PrivateNetworkAvailability;
  credentialReference?: string;
  enabled: boolean;
  lastVerifiedAt?: string;
  name: string;
  providerKind: PrivateNetworkProviderKind;
  providerReference: string;
  verifiedUntil?: string;
}

export type SaveAccessRouteInput = Omit<AccessRouteRecord, 'ownerUserId'>;

export interface AccessRouteAuthorization {
  allowed: boolean;
  capability: AccessRouteCapability;
  expiresAt: string;
  gatewayId: string;
  ownerUserId: string;
  risk: 'normal' | 'interactive' | 'high';
  target: AccessRouteTarget & { identityRevision: string };
}

export type AccessRouteEligibilityState =
  | 'ready'
  | 'unavailable'
  | 'unverified'
  | 'stale'
  | 'policy_blocked';

export interface AuthorizedAccessRouteSelection {
  credentialReference?: string;
  hostKeySha256?: string;
  ownerUserId: string;
  privateAddress?: string;
  privateNetworkId?: string;
  routeId: string;
  routeKind: AccessRouteKind;
  sshPort?: number;
  sshUser?: string;
  target: AccessRouteTarget;
  targetIdentityRevision: string;
}

export function isCredentialReference(value: string) {
  return value.length <= 512 && /^op:\/\/[^\r\n/]+\/[^\r\n/]+\/.+$/.test(value);
}

export function isPinnedSshHostKey(value: string) {
  return /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
}

export function isPrivateAddress(value: string) {
  if (value.trim() !== value || value.length === 0 || value.length > 253 ||
    /[\r\n\s/@]/.test(value)) return false;
  const family = isIP(value);
  if (family === 4) {
    const [first, second] = value.split('.').map(Number);
    return first === 10 || first === 192 && second === 168 ||
      first === 172 && second !== undefined && second >= 16 && second <= 31 ||
      first === 100 && second !== undefined && second >= 64 && second <= 127;
  }
  if (family === 6) return /^f[cd]/i.test(value);
  return value.toLowerCase().endsWith('.ts.net');
}

export function isTargetIdentityRevision(value: string) {
  return value.length >= 8 && value.length <= 256 && /^[A-Za-z0-9:._-]+$/.test(value);
}

export function targetIdentityRevision(identity: { key: string; version: number }) {
  return `${identity.version}:${identity.key}`;
}

export function routeCapabilitiesMatchKind(
  kind: AccessRouteKind,
  capabilities: readonly AccessRouteCapability[]
) {
  const allowed: Record<AccessRouteKind, readonly AccessRouteCapability[]> = {
    host_console: ['host_console', 'host_power'],
    hostd: ['hostd_telemetry'],
    provider_native: ['project_cli', 'interactive_shell', 'provider_exec'],
    ssh_private_network: ['project_cli', 'interactive_shell']
  };
  return capabilities.length > 0 && capabilities.every((capability) =>
    allowed[kind].includes(capability)
  );
}
