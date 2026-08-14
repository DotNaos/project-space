import { describe, expect, test } from 'bun:test';

import {
  createTailscaleProviderConnectionService,
  TailscaleProviderConnectionError
} from '../server/tailscale-inventory/provider-connection-service';

const credentials = { clientId: 'client-id-private', clientSecret: 'client-secret-private' };
const snapshot = {
  backendState: 'running' as const, deviceErrors: [], devices: [],
  freshness: {
    freshUntil: '2026-08-14T10:01:00.000Z', observedAt: '2026-08-14T10:00:00.000Z',
    state: 'fresh' as const
  },
  source: 'tailscale_api_devices' as const
};

describe('Tailscale provider connection service', () => {
  test('verifies before saving and returns only safe connection metadata', async () => {
    const calls: unknown[] = [];
    const service = createTailscaleProviderConnectionService({
      api: { async observe(input) { calls.push(['verify', input]); return { available: true, snapshot }; } },
      connections: {
        async readStatus() { return null; },
        async saveVerified(input) {
          calls.push(['save', input]);
          return status(input.ownerUserId);
        },
        async revoke() { return null; }
      },
      describe: async () => ({ connectionState: 'not_connected', source: 'not_connected' }),
      inventory: { async reconcile(owner, input) { calls.push(['reconcile', owner, input]); } },
      now: () => new Date('2026-08-14T10:00:00Z')
    });

    const result = await service.connect({ actorId: 'owner-a', ownerUserId: 'owner-a' }, credentials);

    expect(calls.map((entry) => (entry as unknown[])[0])).toEqual(['verify', 'save', 'reconcile']);
    expect(result).toEqual({
      connectionId: '10000000-0000-4000-8000-000000000001',
      connectedAt: '2026-08-14T10:00:00.000Z', connectionState: 'connected',
      requiredScope: 'devices:core:read', source: 'tailscale_oauth_api',
      verifiedAt: '2026-08-14T10:00:00.000Z'
    });
    expect(JSON.stringify(result)).not.toMatch(/client-id-private|client-secret-private|token|cipher/i);
  });

  test('does not persist rejected credentials and sanitizes provider failures', async () => {
    for (const [providerCode, serviceCode] of [
      ['credentials_invalid', 'credentials-invalid'],
      ['scope_insufficient', 'scope-insufficient'],
      ['api_unavailable', 'provider-unavailable'],
      ['invalid_api_response', 'provider-response-invalid']
    ] as const) {
      let saved = false;
      const service = createTailscaleProviderConnectionService({
        api: { async observe() { return { available: false as const, error: { code: providerCode, source: 'api' as const } }; } },
        connections: {
          async readStatus() { return null; },
          async saveVerified() { saved = true; return status('owner-a'); },
          async revoke() { return null; }
        },
        describe: async () => ({ connectionState: 'not_connected', source: 'not_connected' }),
        inventory: { async reconcile() { throw new Error('must not reconcile'); } }
      });
      await expect(service.connect({ actorId: 'owner-a', ownerUserId: 'owner-a' }, credentials))
        .rejects.toMatchObject({ code: serviceCode, name: TailscaleProviderConnectionError.name });
      expect(saved).toBe(false);
    }
  });

  test('revokes only the authenticated owner and exposes no credential material', async () => {
    const revokedOwners: string[] = [];
    const service = createTailscaleProviderConnectionService({
      api: { async observe() { throw new Error('must not verify'); } },
      connections: {
        async readStatus() { return null; },
        async saveVerified() { throw new Error('must not save'); },
        async revoke(input) { revokedOwners.push(input.ownerUserId); return status(input.ownerUserId, 'revoked'); }
      },
      describe: async () => ({ connectionState: 'connected', source: 'tailscale_oauth_api' }),
      inventory: { async reconcile() { throw new Error('must not reconcile'); } }
    });
    const result = await service.revoke({ actorId: 'owner-b', ownerUserId: 'owner-b' });
    expect(revokedOwners).toEqual(['owner-b']);
    expect(result).toMatchObject({
      connectionId: '10000000-0000-4000-8000-000000000001',
      connectionState: 'reauthorization_required', source: 'tailscale_oauth_api'
    });
    expect(JSON.stringify(result)).not.toMatch(/client|secret|token|credential|cipher/i);
  });
});

function status(ownerUserId: string, state: 'active' | 'revoked' = 'active') {
  return {
    connectionId: '10000000-0000-4000-8000-000000000001',
    createdAt: '2026-08-14T10:00:00.000Z', ownerUserId, revision: state === 'active' ? 1 : 2,
    state, verifiedAt: '2026-08-14T10:00:00.000Z'
  };
}
