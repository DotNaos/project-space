import { execFile } from 'node:child_process';
import { isIP, connect as openSocket } from 'node:net';
import { promisify } from 'node:util';

import type { MachineHostProbeResult } from './service';

const execFileAsync = promisify(execFile);
const probeTimeoutMs = 3_000;

interface TailscaleNode {
  DNSName?: unknown;
  HostName?: unknown;
  LastSeen?: unknown;
  Online?: unknown;
  TailscaleIPs?: unknown;
}

interface TailscaleStatus {
  BackendState?: unknown;
  Peer?: unknown;
  Self?: unknown;
}

export interface MachineHostProberOptions {
  connect?(host: string, port: number): Promise<boolean>;
  now?(): Date;
  readTailscaleStatus?(): Promise<string>;
}

export function createMachineHostProber(
  options: MachineHostProberOptions = {}
) {
  const connect = options.connect ?? connectTcp;
  const now = options.now ?? (() => new Date());
  const readStatus = options.readTailscaleStatus ?? readTailscaleStatus;

  return async function probe(hostname: string): Promise<MachineHostProbeResult> {
    const checkedAt = now().toISOString();
    let status: TailscaleStatus;
    try {
      status = parseStatus(await readStatus());
    } catch (error) {
      const unsupported = isMissingExecutable(error);
      return {
        ssh: {
          message: 'SSH was not checked because Tailscale evidence is unavailable.',
          state: 'unknown'
        },
        tailscale: {
          checkedAt,
          message: unsupported
            ? 'Tailscale is not installed on the Project Space host.'
            : 'Tailscale status could not be verified.',
          state: unsupported ? 'unsupported' : 'unknown'
        }
      };
    }
    if (status.BackendState !== 'Running') {
      return {
        ssh: {
          message: 'SSH was not checked because Tailscale is not connected.',
          state: 'unknown'
        },
        tailscale: {
          checkedAt,
          message: 'Tailscale is installed but not connected.',
          state: 'unknown'
        }
      };
    }

    const matches = nodes(status).filter((node) =>
      nodeNames(node).includes(normalizeHostname(hostname))
    );
    if (matches.length !== 1) {
      return {
        ssh: {
          message: 'SSH was not checked because the Tailscale node is ambiguous.',
          state: 'unknown'
        },
        tailscale: {
          checkedAt,
          message: matches.length === 0
            ? 'No exact Tailscale node matches the approved machine hostname.'
            : 'More than one Tailscale node matches the approved machine hostname.',
          state: 'unknown'
        }
      };
    }
    const node = matches[0]!;
    const lastSeenAt = timestamp(node.LastSeen);
    if (node.Online !== true) {
      const state = node.Online === false
        ? 'unreachable'
        : lastSeenAt
          ? 'stale'
          : 'unknown';
      return {
        ssh: {
          message: `SSH was not checked because Tailscale is ${state}.`,
          state: 'unknown'
        },
        tailscale: {
          checkedAt,
          ...(lastSeenAt ? { lastSeenAt } : {}),
          state
        }
      };
    }
    const host = addresses(node)[0];
    if (!host) {
      return {
        ssh: {
          checkedAt,
          message: 'The reachable Tailscale node has no usable address for an SSH check.',
          state: 'unknown'
        },
        tailscale: {
          checkedAt,
          lastSeenAt: checkedAt,
          state: 'reachable'
        }
      };
    }
    const sshAvailable = await connect(host, 22).catch(() => false);
    return {
      ssh: {
        checkedAt,
        ...(sshAvailable ? { lastSeenAt: checkedAt } : {}),
        state: sshAvailable ? 'available' : 'unavailable'
      },
      tailscale: {
        checkedAt,
        lastSeenAt: checkedAt,
        state: 'reachable'
      }
    };
  };
}

async function readTailscaleStatus() {
  const result = await execFileAsync('tailscale', ['status', '--json'], {
    timeout: probeTimeoutMs,
    windowsHide: true
  });
  return result.stdout;
}

function connectTcp(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = openSocket({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, probeTimeoutMs);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

function parseStatus(value: string): TailscaleStatus {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid Tailscale status');
  }
  return parsed as TailscaleStatus;
}

function nodes(status: TailscaleStatus) {
  const result: TailscaleNode[] = [];
  if (status.Self && typeof status.Self === 'object' && !Array.isArray(status.Self)) {
    result.push(status.Self as TailscaleNode);
  }
  if (status.Peer && typeof status.Peer === 'object' && !Array.isArray(status.Peer)) {
    for (const node of Object.values(status.Peer)) {
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        result.push(node as TailscaleNode);
      }
    }
  }
  return result;
}

function nodeNames(node: TailscaleNode) {
  const result = new Set<string>();
  for (const value of [node.HostName, node.DNSName]) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeHostname(value);
    if (!normalized) continue;
    result.add(normalized);
    result.add(normalized.split('.')[0] ?? normalized);
  }
  return [...result];
}

function addresses(node: TailscaleNode) {
  if (!Array.isArray(node.TailscaleIPs)) return [];
  return node.TailscaleIPs.filter(
    (value): value is string => typeof value === 'string' && isIP(value) !== 0
  );
}

function normalizeHostname(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\.$/, '');
}

function timestamp(value: unknown) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function isMissingExecutable(error: unknown) {
  return error instanceof Error && 'code' in error &&
    (error as Error & { code?: unknown }).code === 'ENOENT';
}
