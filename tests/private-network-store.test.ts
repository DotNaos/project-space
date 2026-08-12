import { describe, expect, test } from 'bun:test';

import type { DatabaseQueryClient } from '../server/database/client';
import { PostgresPrivateNetworkStore } from '../server/private-network/store';

class RecordingClient implements DatabaseQueryClient {
  calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    this.calls.push({ sql, values });
    return { rows: [] as Row[] };
  }
}

describe('private-network store', () => {
  test('scopes every inventory query to the exact owner', async () => {
    const client = new RecordingClient();
    await new PostgresPrivateNetworkStore(client).list('owner-one');
    expect(client.calls).toHaveLength(2);
    for (const call of client.calls) {
      expect(call.sql).toContain('where owner_user_id = $1');
      expect(call.values).toEqual(['owner-one']);
    }
  });

  test('rejects public SSH targets and non-opaque credentials before persistence', async () => {
    const client = new RecordingClient();
    const store = new PostgresPrivateNetworkStore(client);
    const base = {
      allowedGatewayIds: ['gateway-one'],
      availability: 'available' as const,
      capabilities: ['project_cli' as const],
      credentialPurpose: 'project_control_gateway_v1' as const,
      enabled: true,
      freshnessSeconds: 60,
      hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      id: '20000000-0000-4000-8000-000000000001',
      lastVerifiedAt: '2026-08-12T09:59:30.000Z',
      policyState: 'approved' as const,
      priority: 100,
      privateNetworkId: '10000000-0000-4000-8000-000000000001',
      providerKind: 'tailscale' as const,
      requiresInteractiveApproval: false,
      routeKind: 'ssh_private_network' as const,
      sshPort: 22,
      sshUser: 'oli',
      target: { id: '30000000-0000-4000-8000-000000000001', kind: 'environment' as const },
      targetIdentityRevision: '1:environment-identity',
      verifiedUntil: '2026-08-12T10:05:00.000Z'
    };
    await expect(store.saveRoute('owner-one', {
      ...base, credentialReference: 'raw-secret', privateAddress: '203.0.113.10'
    })).rejects.toThrow('complete pinned configuration');
    expect(client.calls).toHaveLength(0);
  });

  test('keeps newer verification evidence when an older observation is replayed', async () => {
    const client: DatabaseQueryClient = {
      async query<Row>(sql: string) {
        if (sql.startsWith('insert into private_networks')) return { rows: [] as Row[] };
        return { rows: [{
          approval_state: 'approved', availability: 'available', credential_reference: null,
          enabled: true, id: '10000000-0000-4000-8000-000000000001',
          last_verified_at: '2026-08-12T10:00:00.000Z', name: 'Private tailnet',
          owner_user_id: 'owner-one', provider_kind: 'tailscale',
          provider_reference: 'tailnet-one', verified_until: '2026-08-12T10:05:00.000Z'
        }] as Row[] };
      }
    };
    const saved = await new PostgresPrivateNetworkStore(client).saveNetwork('owner-one', {
      approvalState: 'approved', availability: 'available', enabled: true,
      lastVerifiedAt: '2026-08-12T09:59:00.000Z', name: 'Private tailnet',
      providerKind: 'tailscale', providerReference: 'tailnet-one',
      verifiedUntil: '2026-08-12T10:04:00.000Z'
    });
    expect(saved.lastVerifiedAt).toBe('2026-08-12T10:00:00.000Z');
  });

  test('rejects a contradictory equal-time replay', async () => {
    const client: DatabaseQueryClient = {
      async query<Row>(sql: string) {
        if (sql.startsWith('insert into private_networks')) return { rows: [] as Row[] };
        return { rows: [networkRow()] as Row[] };
      }
    };
    await expect(new PostgresPrivateNetworkStore(client).saveNetwork('owner-one', {
      approvalState: 'approved', availability: 'unavailable', enabled: true,
      lastVerifiedAt: '2026-08-12T10:00:00.000Z', name: 'Private tailnet',
      providerKind: 'tailscale', providerReference: 'tailnet-one',
      verifiedUntil: '2026-08-12T10:05:00.000Z'
    })).rejects.toThrow('conflicts with an existing replay');
  });

  test('does not let a stable route id move to another target', async () => {
    const client: DatabaseQueryClient = {
      async query<Row>(sql: string) {
        if (sql.startsWith('insert into access_routes')) return { rows: [] as Row[] };
        return { rows: [{
          allowed_gateway_ids: ['gateway-one'], availability: 'available',
          capabilities: ['project_cli'], credential_reference: 'op://Personal/SSH/private key',
          credential_purpose: 'project_control_gateway_v1',
          enabled: true, environment_id: '30000000-0000-4000-8000-000000000001',
          freshness_seconds: 60, host_id: null,
          id: '20000000-0000-4000-8000-000000000001',
          last_verified_at: '2026-08-12T10:00:00.000Z', owner_user_id: 'owner-one',
          policy_state: 'approved', priority: 100, private_address: '100.64.0.10',
          private_network_id: '10000000-0000-4000-8000-000000000001',
          provider_kind: 'tailscale', requires_interactive_approval: false,
          route_kind: 'ssh_private_network', ssh_host_key_sha256: `SHA256:${'A'.repeat(43)}`,
          ssh_port: 22, ssh_user: 'oli', target_identity_revision: '1:environment-identity',
          verified_until: '2026-08-12T10:05:00.000Z'
        }] as Row[] };
      }
    };
    await expect(new PostgresPrivateNetworkStore(client).saveRoute('owner-one', {
      allowedGatewayIds: ['gateway-one'], availability: 'available',
      capabilities: ['project_cli'], credentialReference: 'op://Personal/SSH/private key',
      credentialPurpose: 'project_control_gateway_v1',
      enabled: true, freshnessSeconds: 60, hostKeySha256: `SHA256:${'A'.repeat(43)}`,
      id: '20000000-0000-4000-8000-000000000001',
      lastVerifiedAt: '2026-08-12T10:01:00.000Z', policyState: 'approved', priority: 100,
      privateAddress: '100.64.0.11',
      privateNetworkId: '10000000-0000-4000-8000-000000000001', providerKind: 'tailscale',
      requiresInteractiveApproval: false, routeKind: 'ssh_private_network', sshPort: 22,
      sshUser: 'oli', target: {
        id: '30000000-0000-4000-8000-000000000002', kind: 'environment'
      }, targetIdentityRevision: '1:environment-identity',
      verifiedUntil: '2026-08-12T10:06:00.000Z'
    })).rejects.toThrow('identity or configuration conflicts');
  });
});

function networkRow() {
  return {
    approval_state: 'approved', availability: 'available', credential_reference: null,
    enabled: true, id: '10000000-0000-4000-8000-000000000001',
    last_verified_at: '2026-08-12T10:00:00.000Z', name: 'Private tailnet',
    owner_user_id: 'owner-one', provider_kind: 'tailscale',
    provider_reference: 'tailnet-one', verified_until: '2026-08-12T10:05:00.000Z'
  };
}
