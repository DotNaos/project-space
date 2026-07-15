import { describe, expect, test } from 'bun:test';

import { isDevelopmentConnector } from '../src/features/project-desktop/components/connector-channel-model';
import type { MachineRecord } from '../src/shared/project-space-api';

function machine(input: {
  name: string;
  profile?: boolean;
  runtimeChannel?: 'stable' | 'beta' | 'dev';
}): MachineRecord {
  const channel = input.runtimeChannel;
  return {
    connector: {
      installCommand: '',
      ...(input.profile ? { profile: { channel: 'dev', source: 'source' } as const } : {}),
      status: 'online',
      ...(channel
        ? {
            runtime: {
              architecture: 'x64',
              buildId: 'a'.repeat(40),
              bundleVersions: { connector: '0.4.5', machineTools: '0.4.5', projectCli: '0.4.5' },
              channel,
              instanceId: 'runtime-1',
              lastCheckedAt: '2026-07-14T00:00:00.000Z',
              platform: 'linux',
              protocolVersion: '2',
              releaseId: 'v0.4.5',
              source: channel === 'dev' ? 'source' : 'managed',
              version: '0.4.5'
            }
          }
        : {})
    },
    id: 'machine-1',
    kind: 'desktop',
    name: input.name,
    network: {},
    roles: [],
    sourcePath: '/connector'
  };
}

describe('connector channel chip', () => {
  test('uses the bound connector profile and never runtime or display-name inference', () => {
    expect(isDevelopmentConnector(machine({ name: 'ordinary-machine', profile: true }))).toBe(true);
    expect(isDevelopmentConnector(machine({ name: 'dev-machine', runtimeChannel: 'dev' }))).toBe(false);
    expect(isDevelopmentConnector(machine({ name: 'dev-machine', runtimeChannel: 'stable' }))).toBe(false);
    expect(isDevelopmentConnector(machine({ name: 'dev-machine' }))).toBe(false);
  });
});
