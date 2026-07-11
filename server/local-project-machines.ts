import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { FileSystemEntry, MachineRecord } from '../src/shared/project-space-api';
import { getRegisteredConnectorMachines } from './connector-hub';
import { getConnectorOverview } from './local-machine-registry';
import { configuredConnectorMachineId } from './project-connector-config';

export async function loadMergedConnectorOverview() {
  const connector = await getConnectorOverview();
  const registeredMachines = getRegisteredConnectorMachines();
  const assignedMachineId = configuredConnectorMachineId();
  const localMachines = connector.machines
    .filter((machine) => !isWebHubMachine(machine))
    .map((machine) =>
      assignedMachineId && (machine.connector.status === 'local' || machine.kind === 'local')
        ? { ...machine, id: assignedMachineId }
        : machine
    );
  const knownMachineIds = new Set(localMachines.map((machine) => machine.id));

  return {
    ...connector,
    machines: [
      ...localMachines,
      ...registeredMachines.filter((machine) => !knownMachineIds.has(machine.id))
    ]
  };
}

export function isWebHubMachine(machine: Pick<MachineRecord, 'connector'>) {
  const serviceName = machine.connector.serviceName ?? '';

  return /^project-space(?:-[a-z0-9]+)*-web$/.test(serviceName);
}

export function createMachineSshTarget(machine: MachineRecord) {
  const host = machine.network.tailscaleIp ?? machine.network.localName ?? machine.name;

  if (!host) {
    return '';
  }

  return machine.network.sshUser ? `${machine.network.sshUser}@${host}` : host;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function remoteCodexRuntime(target: string, cwd: string) {
  const remoteCommand = [
    `cd ${shellQuote(cwd)} || exit $?`,
    'if [ -x /Applications/ChatGPT.app/Contents/Resources/codex ]; then',
    'exec /Applications/ChatGPT.app/Contents/Resources/codex app-server --listen stdio://',
    'elif [ -x /Applications/Codex.app/Contents/Resources/codex ]; then',
    'exec /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://',
    'else',
    'exec codex app-server --listen stdio://',
    'fi'
  ].join('\n');

  return {
    args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, remoteCommand],
    command: 'ssh',
    cwd: homedir()
  };
}

export async function readLocalDirectoryEntries(path: string): Promise<FileSystemEntry[]> {
  let entries: Dirent[];

  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    entries = [];
  }

  return entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({
      kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
      name: entry.name,
      path: resolve(path, entry.name)
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}
