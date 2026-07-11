import { describe, expect, test } from 'bun:test';

import { machineSubtitle } from '../src/features/project-desktop/components/project-main-model';
import type { MachineRecord } from '../src/shared/project-space-api';

function machine(status: 'offline' | 'online'): MachineRecord {
  return {
    connector: {
      lastSeen: '2026-07-11T00:00:00.000Z',
      status
    },
    id: 'macbook',
    kind: 'connector',
    name: 'MacBook',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

describe('machine subtitle', () => {
  test('marks offline projects as last-known without changing online labels', () => {
    expect(machineSubtitle(machine('offline'))).toContain('Offline');
    expect(machineSubtitle(machine('offline'))).toContain('last-known projects');
    expect(machineSubtitle(machine('online'))).toBe('connector');
  });
});
