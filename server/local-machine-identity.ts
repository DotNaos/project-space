import { execFileSync } from 'node:child_process';
import { hostname, platform } from 'node:os';

interface LocalMachineNameInput {
  computerName?: string;
  hostName: string;
  platform: NodeJS.Platform;
}

function normalizedHostName(value: string | undefined) {
  return value?.trim().replace(/\.$/, '').split('.')[0] || undefined;
}

export function resolveLocalMachineName(input: LocalMachineNameInput) {
  return normalizedHostName(
    input.platform === 'darwin' ? input.computerName : undefined
  ) ?? normalizedHostName(input.hostName) ?? 'localhost';
}

function readMacComputerName() {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true
    });
  } catch {
    return undefined;
  }
}

let cachedLocalMachineName: string | undefined;

export function localMachineName() {
  cachedLocalMachineName ??= resolveLocalMachineName({
    computerName: platform() === 'darwin' ? readMacComputerName() : undefined,
    hostName: hostname(),
    platform: platform()
  });
  return cachedLocalMachineName;
}
