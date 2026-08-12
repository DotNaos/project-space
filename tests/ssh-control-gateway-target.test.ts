import { describe, expect, test } from 'bun:test';

import type { ComputeInventorySnapshot } from '../src/shared/compute-environment-api';
import { InventorySshGatewayTargetResolver } from '../server/ssh-control-gateway/target-resolver';

describe('SSH gateway target resolver', () => {
  test('binds one Environment to its Platform, definition, optional Host, and identity', async () => {
    const resolver = new InventorySshGatewayTargetResolver({ load: async () => snapshot() });
    await expect(resolver.resolve('owner-1', 'environment-1')).resolves.toEqual({
      environmentDefinitionId: 'definition-1',
      environmentId: 'environment-1',
      hostId: 'host-1',
      platformId: 'platform-1',
      targetIdentityRevision: '1:environment:test'
    });
  });

  test('fails closed on missing, duplicate, conflicted, or cross-platform targets', async () => {
    for (const current of [
      { ...snapshot(), environments: [] },
      { ...snapshot(), environments: [...snapshot().environments, ...snapshot().environments] },
      {
        ...snapshot(),
        violations: [{ code: 'duplicate_environment_identity' as const, id: 'opaque-derived-key' }]
      },
      {
        ...snapshot(),
        hosts: [{ ...snapshot().hosts[0]!, platformId: 'platform-2' }]
      },
      {
        ...snapshot(),
        environments: [{ ...snapshot().environments[0]!, identityResolution: 'conflict' as const }]
      }
    ]) {
      const resolver = new InventorySshGatewayTargetResolver({ load: async () => current });
      await expect(resolver.resolve('owner-1', 'environment-1'))
        .rejects.toMatchObject({ code: 'route_unavailable' });
    }
  });
});

function snapshot(): ComputeInventorySnapshot {
  return {
    connectors: [],
    environmentDefinitions: [{
      bootstrapStrategy: 'ssh', id: 'definition-1', kind: 'native_linux', name: 'Linux',
      operatingSystemFamily: 'linux', ownership: 'built_in', slug: 'linux',
      supportedArchitectures: []
    }],
    environments: [{
      environmentDefinitionId: 'definition-1',
      hostAssociation: { evidence: 'provider', hostId: 'host-1', resolution: 'verified' },
      id: 'environment-1', identity: { key: 'environment:test', version: 1 },
      kind: 'native_linux', name: 'Target', platformId: 'platform-1', resourceMode: 'dedicated'
    }],
    hosts: [{
      id: 'host-1', identity: { key: 'host:test', version: 1 }, name: 'Host',
      platformId: 'platform-1'
    }],
    platforms: [{ id: 'platform-1', kind: 'local', name: 'Private' }],
    violations: []
  };
}
