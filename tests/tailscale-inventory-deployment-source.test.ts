import { describe, expect, test } from 'bun:test';

import { createDeploymentTailscaleInventorySource, readTailscaleDeploymentCredentials } from
  '../server/tailscale-inventory/deployment-source';

const snapshot = {
  available: true as const,
  snapshot: {
    backendState: 'running' as const,
    deviceErrors: [], devices: [],
    freshness: {
      freshUntil: '2026-08-16T10:01:00.000Z', observedAt: '2026-08-16T10:00:00.000Z',
      state: 'fresh' as const
    },
    source: 'tailscale_api_devices' as const
  }
};

describe('deployment-owned Tailscale inventory source', () => {
  test('reports missing credentials without selecting the legacy source for another owner', async () => {
    expect(readTailscaleDeploymentCredentials({})).toEqual({ kind: 'missing' });
    let legacyCalls = 0;
    const source = createDeploymentTailscaleInventorySource({
      api: { async observe() { throw new Error('must not use API'); } },
      environment: {},
      isLegacyOwner: () => false,
      legacy: legacySource(() => { legacyCalls += 1; })
    });

    await expect(source.describe?.('unrelated-owner')).resolves.toEqual({
      connectionState: 'not_configured', source: 'not_connected'
    });
    await expect(source.observe('unrelated-owner')).resolves.toEqual({
      available: false, error: { code: 'connection_missing', source: 'api' }
    });
    expect(legacyCalls).toBe(0);
  });

  test('rejects partial or malformed deployment credentials without exposing them', async () => {
    const clientId = 'deployment-client-id-private';
    const clientSecret = 'deployment-client-secret-private';
    for (const environment of [
      { TAILSCALE_OAUTH_CLIENT_ID: clientId },
      { TAILSCALE_OAUTH_CLIENT_SECRET: clientSecret },
      { TAILSCALE_OAUTH_CLIENT_ID: ` ${clientId}` },
      { TAILSCALE_OAUTH_CLIENT_SECRET: `${clientSecret}\n` },
      { TAILSCALE_OAUTH_CLIENT_ID: 'short', TAILSCALE_OAUTH_CLIENT_SECRET: clientSecret }
    ]) {
      expect(readTailscaleDeploymentCredentials(environment)).toEqual({ kind: 'invalid' });
    }

    const source = createDeploymentTailscaleInventorySource({
      api: { async observe() { throw new Error('must not use API'); } },
      environment: { TAILSCALE_OAUTH_CLIENT_ID: clientId },
      isLegacyOwner: () => true,
      legacy: legacySource(() => { throw new Error('must not fall back'); })
    });
    const result = await source.observe('legacy-owner');
    expect(result).toEqual({ available: false, error: { code: 'credentials_invalid', source: 'api' } });
    expect(JSON.stringify(result)).not.toContain(clientId);
    expect(JSON.stringify(result)).not.toContain(clientSecret);
  });

  test('uses one configured deployment credential for all authorized owners', async () => {
    const clientId = 'deployment-client-id-private';
    const clientSecret = 'deployment-client-secret-private';
    const calls: Array<{ clientId: string; clientSecret: string }> = [];
    const source = createDeploymentTailscaleInventorySource({
      api: { async observe(credentials) { calls.push(credentials); return snapshot; } },
      environment: {
        TAILSCALE_OAUTH_CLIENT_ID: clientId,
        TAILSCALE_OAUTH_CLIENT_SECRET: clientSecret
      },
      isLegacyOwner: () => false,
      legacy: legacySource()
    });

    await expect(source.describe?.('owner-a')).resolves.toEqual({
      connectionState: 'configured', source: 'tailscale_oauth_api'
    });
    await expect(source.describe?.('owner-b')).resolves.toEqual({
      connectionState: 'configured', source: 'tailscale_oauth_api'
    });
    await expect(source.observe('owner-a')).resolves.toEqual(snapshot);
    await expect(source.observe('owner-b')).resolves.toEqual(snapshot);
    expect(calls).toEqual([
      { clientId, clientSecret },
      { clientId, clientSecret }
    ]);
    expect(JSON.stringify(await source.describe?.('owner-a'))).not.toMatch(/client|secret|credential/i);
  });

  test('keeps the temporary legacy source only for its explicitly configured owner', async () => {
    let legacyCalls = 0;
    const source = createDeploymentTailscaleInventorySource({
      api: { async observe() { throw new Error('must not use API'); } },
      environment: {},
      isLegacyOwner: (owner) => owner === 'legacy-owner',
      legacy: legacySource(() => { legacyCalls += 1; })
    });

    await expect(source.describe?.('legacy-owner')).resolves.toEqual({
      connectionState: 'legacy', source: 'temporary_vps_local_status'
    });
    await expect(source.observe('legacy-owner')).resolves.toEqual(snapshot);
    await expect(source.describe?.('other-owner')).resolves.toEqual({
      connectionState: 'not_configured', source: 'not_connected'
    });
    expect(legacyCalls).toBe(1);
  });
});

function legacySource(onObserve: () => void = () => undefined) {
  return {
    async describe() {
      return { connectionState: 'legacy' as const, source: 'temporary_vps_local_status' as const };
    },
    async observe() {
      onObserve();
      return snapshot;
    }
  };
}
