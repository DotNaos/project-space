import { describe, expect, test } from 'bun:test';

import type {
  AccessRouteAuthorization,
  AccessRouteRecord,
  PrivateNetworkRecord
} from '../server/private-network/contracts';
import {
  routeEvidenceState,
  selectAuthorizedAccessRoute
} from '../server/private-network/route-resolver';

const now = new Date('2026-08-12T10:00:00.000Z');
const network: PrivateNetworkRecord = {
  approvalState: 'approved',
  availability: 'available',
  enabled: true,
  id: '10000000-0000-4000-8000-000000000001',
  lastVerifiedAt: '2026-08-12T09:59:30.000Z',
  name: 'Personal tailnet',
  ownerUserId: 'owner-one',
  providerKind: 'tailscale',
  providerReference: 'raw-tailnet-id',
  verifiedUntil: '2026-08-12T10:05:00.000Z'
};
const route: AccessRouteRecord = {
  allowedGatewayIds: ['gateway-one'],
  availability: 'available',
  capabilities: ['project_cli', 'interactive_shell'],
  credentialReference: 'env://PROJECT_SPACE_SSH_PRIVATE_KEY',
  enabled: true,
  freshnessSeconds: 60,
  hostKeySha256: `SHA256:${'A'.repeat(43)}`,
  id: '20000000-0000-4000-8000-000000000001',
  lastVerifiedAt: '2026-08-12T09:59:30.000Z',
  ownerUserId: 'owner-one',
  policyState: 'approved',
  priority: 100,
  privateAddress: '100.64.0.10',
  privateNetworkId: network.id,
  providerKind: 'tailscale',
  requiresInteractiveApproval: false,
  routeKind: 'ssh_private_network',
  sshPort: 22,
  sshUser: 'oli',
  target: { id: '30000000-0000-4000-8000-000000000001', kind: 'environment' },
  targetIdentityRevision: '1:environment-identity',
  verifiedUntil: '2026-08-12T10:05:00.000Z'
};
const authorization: AccessRouteAuthorization = {
  allowed: true,
  capability: 'project_cli',
  expiresAt: '2026-08-12T10:01:00.000Z',
  gatewayId: 'gateway-one',
  ownerUserId: 'owner-one',
  risk: 'normal',
  target: { ...route.target, identityRevision: route.targetIdentityRevision }
};

function select(overrides: Partial<AccessRouteAuthorization> = {}, routes = [route], networks = [network]) {
  return selectAuthorizedAccessRoute({
    authorization: { ...authorization, ...overrides },
    loadCandidates: async () => ({ networks, routes }),
    now
  });
}

describe('private-network access-route selection', () => {
  test('selects one fresh approved route only after authorization', async () => {
    const selected = await select();
    expect(selected).toMatchObject({ state: 'ready', route: { routeId: route.id } });
  });

  test('does not load sensitive candidates before authorization succeeds', async () => {
    let loads = 0;
    const selected = await selectAuthorizedAccessRoute({
      authorization: { ...authorization, allowed: false },
      loadCandidates: async () => {
        loads += 1;
        return { networks: [network], routes: [route] };
      },
      now
    });
    expect(selected).toEqual({ reason: 'authorization_denied', state: 'blocked' });
    expect(loads).toBe(0);
  });

  test('fails closed for wrong owner, gateway, target identity, or capability', async () => {
    for (const override of [
      { ownerUserId: 'owner-two' },
      { gatewayId: 'gateway-two' },
      { capability: 'provider_exec' as const },
      { target: { ...authorization.target, identityRevision: '1:different-identity' } }
    ]) expect(await select(override)).toEqual({ reason: 'no_route', state: 'blocked' });
  });

  test('requires explicit elevated risk for shell and rejects provider mismatch', async () => {
    expect(await select({ capability: 'interactive_shell' })).toEqual({
      reason: 'no_route', state: 'blocked'
    });
    expect(await select({ capability: 'interactive_shell', risk: 'interactive' }))
      .toMatchObject({ state: 'ready' });
    expect(await select({}, [route], [{ ...network, providerKind: 'wireguard' }])).toEqual({
      reason: 'no_route', state: 'blocked'
    });
  });

  test('rejects missing approval and stale or unverified evidence', async () => {
    expect(await select({}, [route], [{ ...network, approvalState: 'pending' }])).toEqual({
      reason: 'no_route', state: 'blocked'
    });
    expect(routeEvidenceState({
      network,
      now,
      route: { ...route, lastVerifiedAt: '2026-08-12T09:58:00.000Z' },
      targetIdentityRevision: route.targetIdentityRevision
    })).toBe('stale');
    expect(routeEvidenceState({
      network,
      now,
      route: { ...route, availability: 'unknown', lastVerifiedAt: undefined, verifiedUntil: undefined },
      targetIdentityRevision: route.targetIdentityRevision
    })).toBe('unverified');
  });

  test('uses a unique highest priority route and blocks equal-priority ambiguity', async () => {
    const lower = { ...route, id: '20000000-0000-4000-8000-000000000002', priority: 10 };
    expect(await select({}, [lower, route])).toMatchObject({
      state: 'ready', route: { routeId: route.id }
    });
    const tied = { ...route, id: '20000000-0000-4000-8000-000000000003' };
    expect(await select({}, [tied, route])).toEqual({
      candidates: [route.id, tied.id], reason: 'ambiguous', state: 'blocked'
    });
  });

  test('never falls back from an explicit ineligible route', async () => {
    const blocked = { ...route, id: '20000000-0000-4000-8000-000000000004', enabled: false };
    const selected = await selectAuthorizedAccessRoute({
      authorization,
      explicitRouteId: blocked.id,
      loadCandidates: async () => ({ networks: [network], routes: [route, blocked] }),
      now
    });
    expect(selected).toEqual({ reason: 'no_route', state: 'blocked' });
  });
});
