import { describe, expect, test } from 'bun:test';

import { createAccountTailscaleInventorySource } from '../server/tailscale-inventory/account-source';

const snapshot = {
  available: true as const,
  snapshot: {
    backendState: 'running' as const,
    deviceErrors: [], devices: [],
    freshness: {
      freshUntil: '2026-08-14T10:01:00.000Z', observedAt: '2026-08-14T10:00:00.000Z',
      state: 'fresh' as const
    },
    source: 'tailscale_api_devices' as const
  }
};

describe('account-scoped Tailscale inventory source', () => {
  test('resolves each owner through only their own provider credential', async () => {
    const usedClientIds: string[] = [];
    const connections = connectionReader(new Map([
      ['owner-a', active('connection-a', 'client-a-private')],
      ['owner-b', active('connection-b', 'client-b-private')]
    ]));
    const source = createAccountTailscaleInventorySource({
      api: { async observe(credentials) { usedClientIds.push(credentials.clientId); return snapshot; } },
      connections,
      isLegacyOwner: () => false,
      legacy: legacySource()
    });

    await Promise.all([source.observe('owner-a'), source.observe('owner-b')]);

    expect(usedClientIds.sort()).toEqual(['client-a-private', 'client-b-private']);
    await expect(source.describe?.('owner-a')).resolves.toEqual({
      connectionId: 'connection-a', connectionState: 'connected', revision: 1,
      source: 'tailscale_oauth_api'
    });
    await expect(source.describe?.('owner-b')).resolves.toEqual({
      connectionId: 'connection-b', connectionState: 'connected', revision: 1,
      source: 'tailscale_oauth_api'
    });
  });

  test('never selects the VPS-local adapter for an unrelated owner', async () => {
    let legacyCalls = 0;
    const source = createAccountTailscaleInventorySource({
      api: { async observe() { throw new Error('API must not run'); } },
      connections: connectionReader(new Map()),
      isLegacyOwner: (owner) => owner === 'legacy-owner',
      legacy: legacySource(() => { legacyCalls += 1; })
    });

    await expect(source.observe('unrelated-owner')).resolves.toEqual({
      available: false, error: { code: 'connection_missing', source: 'api' }
    });
    await expect(source.describe?.('unrelated-owner')).resolves.toEqual({
      connectionState: 'not_connected', source: 'not_connected'
    });
    await expect(source.observe('legacy-owner')).resolves.toEqual(snapshot);
    await expect(source.describe?.('legacy-owner')).resolves.toEqual({
      connectionState: 'legacy', source: 'temporary_vps_local_status'
    });
    expect(legacyCalls).toBe(1);
  });

  test('revoked or unreadable credentials fail closed instead of falling back', async () => {
    let legacyCalls = 0;
    const revoked = connectionReader(new Map([
      ['legacy-owner', { connectionId: 'revoked-connection', revision: 2, state: 'revoked' as const }]
    ]));
    const revokedSource = createAccountTailscaleInventorySource({
      api: { async observe() { throw new Error('API must not run'); } },
      connections: revoked,
      isLegacyOwner: () => true,
      legacy: legacySource(() => { legacyCalls += 1; })
    });
    await expect(revokedSource.observe('legacy-owner')).resolves.toEqual({
      available: false, error: { code: 'connection_missing', source: 'api' }
    });
    await expect(revokedSource.describe?.('legacy-owner')).resolves.toMatchObject({
      connectionId: 'revoked-connection', connectionState: 'reauthorization_required',
      source: 'tailscale_oauth_api'
    });

    const unreadable = createAccountTailscaleInventorySource({
      api: { async observe() { throw new Error('API must not run'); } },
      connections: {
        async readStatus() { return { connectionId: 'active-connection', revision: 1, state: 'active' as const }; },
        async readActive() { throw new Error('key unavailable'); }
      },
      isLegacyOwner: () => true,
      legacy: legacySource(() => { legacyCalls += 1; })
    });
    await expect(unreadable.observe('legacy-owner')).resolves.toEqual({
      available: false, error: { code: 'credentials_invalid', source: 'api' }
    });
    expect(legacyCalls).toBe(0);
  });
});

function active(connectionId: string, clientId: string) {
  return {
    connectionId,
    credentials: { clientId, clientSecret: `${clientId}-secret` },
    revision: 1,
    state: 'active' as const
  };
}

function connectionReader(records: Map<string, ReturnType<typeof active> | {
  connectionId: string; revision: number; state: 'revoked';
}>) {
  return {
    async readStatus(owner: string) {
      const record = records.get(owner);
      return record ? { connectionId: record.connectionId, revision: record.revision, state: record.state } : null;
    },
    async readActive(owner: string) {
      const record = records.get(owner);
      return record?.state === 'active' ? {
        credentials: record.credentials,
        status: { connectionId: record.connectionId, revision: record.revision, state: record.state }
      } : null;
    }
  };
}

function legacySource(onObserve: () => void = () => undefined) {
  return {
    async describe() {
      return { connectionState: 'legacy' as const, source: 'temporary_vps_local_status' as const };
    },
    async observe() { onObserve(); return snapshot; }
  };
}
