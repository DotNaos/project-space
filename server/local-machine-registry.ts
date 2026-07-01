import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type {
  ConnectorOverviewResult,
  MachineBatteryRecord,
  MachineRecord,
  TailscaleStatusResult
} from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);
const machinesRepoPath = join(homedir(), 'projects', 'machines');
const hostDirectory = join(machinesRepoPath, 'hosts');

async function run(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 5_000,
    windowsHide: true
  });

  return stdout.trim();
}

function parseScalar(line: string, key: string) {
  const match = line.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`));

  return match?.[1]?.replace(/^["']|["']$/g, '');
}

function normalizeBatteryState(value: string | undefined): MachineBatteryRecord['state'] {
  const state = value?.trim().toLowerCase();

  if (state === 'charging') {
    return 'charging';
  }

  if (state === 'discharging') {
    return 'discharging';
  }

  if (state === 'charged' || state === 'full') {
    return 'charged';
  }

  return state ? 'unknown' : undefined;
}

async function loadMacBatteryStatus(): Promise<MachineBatteryRecord | undefined> {
  const output = await run('pmset', ['-g', 'batt']);
  const match = output.match(/(\d{1,3})%;\s*([^;]+)/);

  if (!match) {
    return undefined;
  }

  return {
    percentage: Math.max(0, Math.min(100, Number(match[1]))),
    state: normalizeBatteryState(match[2])
  };
}

async function loadLinuxBatteryStatus(): Promise<MachineBatteryRecord | undefined> {
  const powerSupplyPath = '/sys/class/power_supply';

  if (!existsSync(powerSupplyPath)) {
    return undefined;
  }

  const entries = await readdir(powerSupplyPath, {
    withFileTypes: true
  });
  const battery = entries.find((entry) => entry.name.toLowerCase().startsWith('bat'));

  if (!battery) {
    return undefined;
  }

  const batteryPath = join(powerSupplyPath, battery.name);
  const capacity = Number(readFileSync(join(batteryPath, 'capacity'), 'utf-8').trim());
  const state = existsSync(join(batteryPath, 'status'))
    ? readFileSync(join(batteryPath, 'status'), 'utf-8').trim()
    : undefined;

  if (!Number.isFinite(capacity)) {
    return undefined;
  }

  return {
    percentage: Math.max(0, Math.min(100, capacity)),
    state: normalizeBatteryState(state)
  };
}

export async function loadBatteryStatus(): Promise<MachineBatteryRecord | undefined> {
  try {
    if (platform() === 'darwin') {
      return await loadMacBatteryStatus();
    }

    if (platform() === 'linux') {
      return await loadLinuxBatteryStatus();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseHostFile(path: string): MachineRecord {
  const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
  const roles: string[] = [];
  const network: MachineRecord['network'] = {};
  let section = '';
  let name = basename(path, '.yml');
  let kind = 'unknown';
  let primaryUser = '';
  let profile = '';

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue;
    }

    if (!line.startsWith(' ') && line.endsWith(':')) {
      section = line.slice(0, -1);
      continue;
    }

    if (!line.startsWith(' ')) {
      name = parseScalar(line, 'name') ?? name;
      kind = parseScalar(line, 'kind') ?? kind;
      primaryUser = parseScalar(line, 'primary_user') ?? primaryUser;
      profile = basename(parseScalar(line, 'profile') ?? profile, '.yml');
      continue;
    }

    const trimmed = line.trim();

    if (section === 'roles' && trimmed.startsWith('- ')) {
      roles.push(basename(trimmed.slice(2), '.yml'));
    }

    if (section === 'network') {
      network.localName = parseScalar(trimmed, 'local_name') ?? network.localName;
      network.sshUser = parseScalar(trimmed, 'ssh_user') ?? network.sshUser;
    }
  }

  const currentHost = hostname().split('.')[0];
  const hostNames = new Set([network.localName, name].filter(Boolean));
  const isLocal = hostNames.has(currentHost) || hostNames.has(hostname());

  return {
    connector: {
      installCommand: 'project-space connector install',
      origin: isLocal ? process.env.PROJECT_SPACE_CONNECTOR_ORIGIN : undefined,
      serviceName: process.env.PROJECT_CONNECTOR_SERVICE_NAME ?? 'project-space-connector',
      status: isLocal ? 'local' : 'not-installed'
    },
    id: name,
    kind,
    name,
    network,
    primaryUser: primaryUser || undefined,
    profile: profile || undefined,
    roles,
    sourcePath: path
  };
}

async function loadTailscaleStatus(): Promise<TailscaleStatusResult> {
  try {
    const [rawStatus, rawServeStatus] = await Promise.all([
      run('tailscale', ['status', '--json']),
      run('tailscale', ['serve', 'status', '--json']).catch(() => '')
    ]);
    const status = JSON.parse(rawStatus) as {
      BackendState?: string;
      CurrentTailnet?: { Name?: string };
      Peer?: Record<string, { Online?: boolean }>;
      Self?: {
        DNSName?: string;
        HostName?: string;
        TailscaleIPs?: string[];
      };
    };
    const serveStatus = rawServeStatus
      ? (JSON.parse(rawServeStatus) as { Web?: Record<string, unknown> })
      : {};

    return {
      connected: status.BackendState === 'Running',
      installed: true,
      ips: status.Self?.TailscaleIPs ?? [],
      peersOnline: Object.values(status.Peer ?? {}).filter((peer) => peer.Online).length,
      serveOrigins: Object.keys(serveStatus.Web ?? {}).map((origin) => `https://${origin}`),
      selfName: status.Self?.HostName ?? status.Self?.DNSName?.replace(/\.$/, ''),
      tailnet: status.CurrentTailnet?.Name
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Could not read Tailscale status.',
      installed: false,
      ips: [],
      peersOnline: 0,
      serveOrigins: []
    };
  }
}

async function loadMachines() {
  if (!existsSync(hostDirectory)) {
    return [];
  }

  const entries = await readdir(hostDirectory, {
    withFileTypes: true
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
    .map((entry) => parseHostFile(resolve(hostDirectory, entry.name)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function getConnectorOverview(): Promise<ConnectorOverviewResult> {
  const [tailscale, machines, battery] = await Promise.all([
    loadTailscaleStatus(),
    loadMachines(),
    loadBatteryStatus()
  ]);

  const currentHost = hostname().split('.')[0];
  const machinesWithTailscale = machines.map((machine) => {
    const isLocal =
      machine.name === currentHost ||
      machine.network.localName === currentHost ||
      (Boolean(tailscale.selfName) &&
        (machine.network.localName === tailscale.selfName || machine.name === tailscale.selfName));

    if (isLocal) {
      return {
        ...machine,
        battery,
        connector: {
          ...machine.connector,
          lastSeen: new Date().toISOString(),
          origin: process.env.PROJECT_SPACE_CONNECTOR_ORIGIN,
          serviceName: process.env.PROJECT_CONNECTOR_SERVICE_NAME ?? 'project-space-connector',
          status: 'local' as const
        },
        network: {
          ...machine.network,
          tailscaleIp: tailscale.ips[0]
        }
      };
    }

    return machine;
  });
  const hasLocalMachine = machinesWithTailscale.some((machine) => machine.connector.status === 'local');

  if (!hasLocalMachine) {
    machinesWithTailscale.unshift({
      battery,
      connector: {
        installCommand: 'project-space connector install',
        lastSeen: new Date().toISOString(),
        origin: process.env.PROJECT_SPACE_CONNECTOR_ORIGIN,
        serviceName: process.env.PROJECT_CONNECTOR_SERVICE_NAME ?? 'project-space-connector',
        status: 'local'
      },
      id: currentHost,
      kind: platform(),
      name: currentHost,
      network: {
        localName: currentHost,
        tailscaleIp: tailscale.ips[0]
      },
      roles: ['connector'],
      sourcePath: ''
    });
  }

  return {
    connectorOrigin: process.env.PROJECT_SPACE_CONNECTOR_ORIGIN,
    machines: machinesWithTailscale,
    machinesRepo: {
      exists: existsSync(machinesRepoPath),
      path: machinesRepoPath
    },
    tailscale
  };
}
