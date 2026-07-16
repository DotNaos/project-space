import type { MachineRecord } from '@/shared/project-space-api';

export type MachineOsFamily = 'linux' | 'macos' | 'ubuntu' | 'unknown' | 'windows';

function platformValues(machine: MachineRecord) {
  return [
    machine.connector.runtime?.platform,
    machine.os?.family,
    machine.kind,
    machine.profile,
    ...machine.roles
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim().toLowerCase());
}

export function machineOsFamily(machine: MachineRecord): MachineOsFamily {
  const values = platformValues(machine);
  for (const value of values) {
    if (value === 'darwin' || value === 'macos') return 'macos';
    if (value === 'ubuntu') return 'ubuntu';
    if (value === 'windows' || value === 'win32') return 'windows';
    if (value === 'linux' || value === 'unix') return 'linux';
  }
  return 'unknown';
}

export function machineOsLabel(machine: MachineRecord) {
  const labels: Record<MachineOsFamily, string | undefined> = {
    linux: 'Linux',
    macos: 'macOS',
    ubuntu: 'Ubuntu',
    unknown: undefined,
    windows: 'Windows'
  };
  return labels[machineOsFamily(machine)];
}
