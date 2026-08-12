import { describe, expect, test } from 'bun:test';

import type { PrivateNetworkProviderAdapter } from '../server/private-network/provider';
import type {
  AccessRouteRecord,
  PrivateNetworkProviderKind,
  PrivateNetworkRecord
} from '../server/private-network/contracts';
import { applyPrivateNetworkObservation } from '../server/private-network/observation-mapper';
import { selectAuthorizedAccessRoute } from '../server/private-network/route-resolver';
import { tailscaleProviderAdapter } from '../server/private-network/tailscale-provider';

interface WireGuardFixture {
  address: string;
  handshakeFresh: boolean;
}

const wireGuardFixtureAdapter: PrivateNetworkProviderAdapter<WireGuardFixture> = {
  providerKind: 'wireguard',
  observe(fixture) {
    return {
      availability: fixture.handshakeFresh ? 'available' : 'unavailable',
      gatewayMember: true,
      networkPolicyApproved: true,
      privateAddress: fixture.address,
      providerKind: 'wireguard',
      targetIdentityRevision: '1:wireguard-target',
      verifiedAt: '2026-08-12T10:00:00.000Z'
    };
  }
};

describe('private-network provider adapters', () => {
  test('maps Tailscale into the provider-neutral observation contract', () => {
    const observation = tailscaleProviderAdapter.observe({
      gatewayMember: true,
      magicDnsName: 'os-pc.example.ts.net',
      networkPolicyApproved: true,
      nodeOnline: true,
      privateAddresses: ['100.64.0.10'],
      targetIdentityRevision: '1:tailscale-target',
      verifiedAt: '2026-08-12T10:00:00Z'
    });
    expect(observation).toEqual({
      availability: 'available',
      gatewayMember: true,
      networkPolicyApproved: true,
      privateAddress: 'os-pc.example.ts.net',
      providerKind: 'tailscale',
      targetIdentityRevision: '1:tailscale-target',
      verifiedAt: '2026-08-12T10:00:00.000Z'
    });
    expect(JSON.stringify(observation)).not.toContain('nodeOnline');
  });

  test('uses the same observation contract for a WireGuard fixture', () => {
    expect(wireGuardFixtureAdapter.observe({ address: '10.8.0.2', handshakeFresh: true }))
      .toMatchObject({ availability: 'available', providerKind: 'wireguard' });
  });

  test('takes Tailscale and WireGuard evidence through the same authorized resolver', async () => {
    const tailscale = tailscaleProviderAdapter.observe({
      gatewayMember: true, networkPolicyApproved: true, nodeOnline: true,
      privateAddresses: ['100.64.0.10'], targetIdentityRevision: '1:provider-target',
      verifiedAt: '2026-08-12T10:00:00Z'
    });
    const wireguard = wireGuardFixtureAdapter.observe({
      address: '10.8.0.2', handshakeFresh: true
    });
    wireguard.targetIdentityRevision = '1:provider-target';
    for (const observation of [tailscale, wireguard]) {
      const configured = records(observation.providerKind);
      const mapped = applyPrivateNetworkObservation({
        freshnessSeconds: 60,
        ...configured,
        observation
      });
      const selected = await selectAuthorizedAccessRoute({
        authorization: {
          allowed: true, capability: 'project_cli', expiresAt: '2026-08-12T10:00:30Z',
          gatewayId: 'gateway-one', ownerUserId: 'owner-one', risk: 'normal',
          target: { ...mapped.route.target, identityRevision: mapped.route.targetIdentityRevision }
        },
        loadCandidates: async () => ({ networks: [mapped.network], routes: [mapped.route] }),
        now: new Date('2026-08-12T10:00:15Z')
      });
      expect(selected).toMatchObject({ state: 'ready', route: { routeId: mapped.route.id } });
    }
  });

  test('keeps network reachability separate but blocks negative policy or gateway evidence', async () => {
    for (const evidence of [
      { gatewayMember: false, networkPolicyApproved: true },
      { gatewayMember: true, networkPolicyApproved: false }
    ]) {
      const observation = tailscaleProviderAdapter.observe({
        ...evidence, nodeOnline: true, privateAddresses: ['100.64.0.10'],
        targetIdentityRevision: '1:provider-target', verifiedAt: '2026-08-12T10:00:00Z'
      });
      const mapped = applyPrivateNetworkObservation({
        freshnessSeconds: 60, ...records('tailscale'), observation
      });
      expect(mapped.network.availability).toBe('available');
      expect(mapped.route.availability).toBe('unavailable');
      const selected = await selectAuthorizedAccessRoute({
        authorization: {
          allowed: true, capability: 'project_cli', expiresAt: '2026-08-12T10:00:30Z',
          gatewayId: 'gateway-one', ownerUserId: 'owner-one', risk: 'normal',
          target: { ...mapped.route.target, identityRevision: mapped.route.targetIdentityRevision }
        },
        loadCandidates: async () => ({ networks: [mapped.network], routes: [mapped.route] }),
        now: new Date('2026-08-12T10:00:15Z')
      });
      expect(selected).toEqual({ reason: 'no_route', state: 'blocked' });
    }
  });

  test('rejects public Tailscale targets', () => {
    expect(() => tailscaleProviderAdapter.observe({
      gatewayMember: true,
      networkPolicyApproved: true,
      nodeOnline: true,
      privateAddresses: ['203.0.113.10'],
      targetIdentityRevision: '1:tailscale-target',
      verifiedAt: '2026-08-12T10:00:00Z'
    })).toThrow('no approved private address');
  });
});

function records(providerKind: PrivateNetworkProviderKind): {
  network: PrivateNetworkRecord;
  route: AccessRouteRecord;
} {
  const network: PrivateNetworkRecord = {
    approvalState: 'approved', availability: 'available', enabled: true,
    id: '10000000-0000-4000-8000-000000000001', name: 'Private network',
    lastVerifiedAt: '2026-08-12T10:00:00.000Z', ownerUserId: 'owner-one', providerKind,
    providerReference: 'opaque-provider-reference', verifiedUntil: '2026-08-12T10:01:00.000Z'
  };
  return {
    network,
    route: {
      allowedGatewayIds: ['gateway-one'], availability: 'unknown', capabilities: ['project_cli'],
      credentialReference: 'op://Personal/SSH/private key', enabled: true, freshnessSeconds: 60,
      hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      id: '20000000-0000-4000-8000-000000000001', ownerUserId: 'owner-one',
      policyState: 'approved', priority: 100, privateNetworkId: network.id, providerKind,
      requiresInteractiveApproval: false, routeKind: 'ssh_private_network', sshPort: 22,
      sshUser: 'oli', target: {
        id: '30000000-0000-4000-8000-000000000001', kind: 'environment'
      },
      targetIdentityRevision: '1:provider-target'
    }
  };
}
