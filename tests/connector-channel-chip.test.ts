import { describe, expect, test } from 'bun:test';

import { isDevelopmentConnector } from '../src/features/project-desktop/components/connector-channel-model';
import type { MachineRecord } from '../src/shared/project-space-api';

function machine(name: string, channel?: 'stable' | 'beta' | 'dev'): MachineRecord {
  return {
    connector: {
      installCommand: '',
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
    name,
    network: {},
    roles: [],
    sourcePath: '/connector'
  };
}

describe('connector channel chip', () => {
  test('uses explicit runtime metadata and never the display name', () => {
    expect(isDevelopmentConnector(machine('ordinary-machine', 'dev'))).toBe(true);
    expect(isDevelopmentConnector(machine('dev-machine', 'stable'))).toBe(false);
    expect(isDevelopmentConnector(machine('dev-machine'))).toBe(false);
  });
});
