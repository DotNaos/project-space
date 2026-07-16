import { describe, expect, test } from 'bun:test';
import type { MachineRecord } from '../src/shared/project-space-api';
import {
  machineOsFamily,
  machineOsLabel
} from '../src/features/project-desktop/components/machine-platform-model';

function machine(input: Partial<MachineRecord> = {}): MachineRecord {
  return {
    connector: { installCommand: '', status: 'online' },
    id: 'machine-1',
    kind: 'connector',
    name: 'display-name-must-not-decide-platform',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub',
    ...input
  };
}

describe('machine platform presentation', () => {
  test('uses reported runtime, OS, and kind metadata for recognizable labels', () => {
    expect(machineOsLabel(machine({ kind: 'win32' }))).toBe('Windows');
    expect(machineOsLabel(machine({ os: { family: 'ubuntu' } }))).toBe('Ubuntu');
    expect(machineOsLabel(machine({ kind: 'darwin' }))).toBe('macOS');
    expect(machineOsLabel(machine({ kind: 'linux' }))).toBe('Linux');
  });

  test('prefers runtime platform and never infers an OS from the display name', () => {
    const runtimeMachine = machine({
      connector: {
        installCommand: '',
        runtime: {
          architecture: 'x64',
          buildId: 'a'.repeat(40),
          bundleVersions: { connector: '0.4.8', machineTools: '0.4.8', projectCli: '0.4.8' },
          channel: 'stable',
          instanceId: 'runtime-1',
          lastCheckedAt: '2026-07-16T00:00:00.000Z',
          platform: 'windows',
          protocolVersion: '2',
          releaseId: 'v0.4.8',
          source: 'managed',
          version: '0.4.8'
        },
        status: 'online'
      },
      kind: 'linux',
      name: 'definitely-a-macbook'
    });
    expect(machineOsFamily(runtimeMachine)).toBe('windows');
    expect(machineOsLabel(machine({ name: 'windows-ubuntu-mac' }))).toBeUndefined();
  });
});
