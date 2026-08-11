import { isIP } from 'node:net';

import { isPrivateAddress, isTargetIdentityRevision } from './contracts';
import type { PrivateNetworkProviderAdapter } from './provider';

export interface TailscaleRouteEvidence {
  gatewayMember: boolean;
  magicDnsName?: string;
  networkPolicyApproved: boolean;
  nodeOnline: boolean;
  privateAddresses: readonly string[];
  targetIdentityRevision: string;
  verifiedAt: string;
}

export const tailscaleProviderAdapter: PrivateNetworkProviderAdapter<TailscaleRouteEvidence> = {
  providerKind: 'tailscale',
  observe(evidence) {
    const verifiedAt = parseObservedAt(evidence.verifiedAt);
    if (!isTargetIdentityRevision(evidence.targetIdentityRevision)) {
      throw new Error('Tailscale evidence has no valid target identity revision.');
    }
    const privateAddress = selectPrivateAddress(evidence);
    return {
      availability: evidence.nodeOnline ? 'available' : 'unavailable',
      gatewayMember: evidence.gatewayMember,
      networkPolicyApproved: evidence.networkPolicyApproved,
      privateAddress,
      providerKind: 'tailscale',
      targetIdentityRevision: evidence.targetIdentityRevision,
      verifiedAt
    };
  }
};

function selectPrivateAddress(evidence: TailscaleRouteEvidence) {
  const addresses = [...evidence.privateAddresses].filter(isTailscaleAddress).sort();
  const magicDnsName = evidence.magicDnsName?.trim().toLowerCase();
  if (magicDnsName && isPrivateAddress(magicDnsName) && magicDnsName.endsWith('.ts.net')) {
    return magicDnsName;
  }
  const address = addresses[0];
  if (!address) throw new Error('Tailscale evidence has no approved private address.');
  return address;
}

function isTailscaleAddress(value: string) {
  const family = isIP(value);
  if (family === 4) {
    const [first, second] = value.split('.').map(Number);
    return first === 100 && second !== undefined && second >= 64 && second <= 127;
  }
  if (family === 6) return value.toLowerCase().startsWith('fd7a:115c:a1e0:');
  return false;
}

function parseObservedAt(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Tailscale evidence has an invalid verification time.');
  return new Date(parsed).toISOString();
}
