import { describe, expect, test } from 'bun:test';

import { createMachineHostProber } from '../server/machine-directory/probe';

const checkedAt = '2026-07-28T16:00:00.000Z';

function tailscaleStatus(online: boolean | undefined = true) {
  return JSON.stringify({
    BackendState: 'Running',
    Peer: {
      node: {
        DNSName: 'os-pc.example.ts.net.',
        HostName: 'os-pc',
        LastSeen: '2026-07-28T15:55:00.000Z',
        Online: online,
        TailscaleIPs: ['100.64.0.42']
      }
    },
    Self: {
      DNSName: 'os-macbook.example.ts.net.',
      HostName: 'os-macbook',
      Online: true,
      TailscaleIPs: ['100.64.0.10']
    }
  });
}

describe('machine directory reachability probe', () => {
  test('maps an approved hostname to exact Tailscale evidence and checks SSH separately', async () => {
    const connections: Array<{ host: string; port: number }> = [];
    const probe = createMachineHostProber({
      async connect(host, port) {
        connections.push({ host, port });
        return true;
      },
      now: () => new Date(checkedAt),
      readTailscaleStatus: async () => tailscaleStatus()
    });

    const result = await probe('os-pc');

    expect(result).toEqual({
      ssh: {
        checkedAt,
        lastSeenAt: checkedAt,
        state: 'available'
      },
      tailscale: {
        checkedAt,
        lastSeenAt: checkedAt,
        state: 'reachable'
      }
    });
    expect(connections).toEqual([{ host: '100.64.0.42', port: 22 }]);
    expect(JSON.stringify(result)).not.toContain('100.64.0.42');
  });

  test('does not match display-name substrings or ambiguous nodes', async () => {
    const probe = createMachineHostProber({
      connect: async () => {
        throw new Error('must not connect');
      },
      now: () => new Date(checkedAt),
      readTailscaleStatus: async () => JSON.stringify({
        BackendState: 'Running',
        Peer: {
          one: {
            DNSName: 'os-pc-one.example.ts.net.',
            HostName: 'os-pc-one',
            Online: true,
            TailscaleIPs: ['100.64.0.41']
          },
          two: {
            DNSName: 'os-pc-two.example.ts.net.',
            HostName: 'os-pc-two',
            Online: true,
            TailscaleIPs: ['100.64.0.42']
          }
        }
      })
    });

    expect(await probe('os-pc')).toMatchObject({
      ssh: { state: 'unknown' },
      tailscale: { state: 'unknown' }
    });
  });

  test('keeps unreachable Tailscale separate from unknown SSH', async () => {
    const probe = createMachineHostProber({
      connect: async () => {
        throw new Error('must not connect');
      },
      now: () => new Date(checkedAt),
      readTailscaleStatus: async () => tailscaleStatus(false)
    });

    expect(await probe('os-pc')).toEqual({
      ssh: {
        message: 'SSH was not checked because Tailscale is unreachable.',
        state: 'unknown'
      },
      tailscale: {
        checkedAt,
        lastSeenAt: '2026-07-28T15:55:00.000Z',
        state: 'unreachable'
      }
    });
  });

  test('reports missing Tailscale tooling as unsupported without inferring power state', async () => {
    const unavailable = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const probe = createMachineHostProber({
      connect: async () => false,
      now: () => new Date(checkedAt),
      readTailscaleStatus: async () => {
        throw unavailable;
      }
    });

    const result = await probe('os-pc');
    expect(result).toMatchObject({
      ssh: { state: 'unknown' },
      tailscale: { state: 'unsupported' }
    });
    expect(JSON.stringify(result)).not.toContain('power');
  });
});
