import { describe, expect, test } from 'bun:test';

import {
  createCommandTailscaleInventorySource,
  tailscaleStatusArgs,
  tailscaleStatusCommand,
  tailscaleStatusOutputLimitBytes,
  tailscaleStatusTimeoutMs,
  type TailscaleStatusCommandRunner
} from '../server/tailscale-inventory/command-source';

const observedAt = new Date('2026-08-14T10:00:00Z');

describe('command Tailscale inventory source', () => {
  test('runs only tailscale status --json with a bounded no-shell command', async () => {
    const calls: unknown[][] = [];
    const source = createCommandTailscaleInventorySource({
      now: () => observedAt,
      runner: {
        async run(command, args, options) {
          calls.push([command, args, options]);
          return { stdout: JSON.stringify(status()) };
        }
      }
    });

    expect(await source.observe()).toMatchObject({ available: true });
    expect(calls).toEqual([[
      tailscaleStatusCommand,
      tailscaleStatusArgs,
      { maxBuffer: tailscaleStatusOutputLimitBytes, timeout: tailscaleStatusTimeoutMs, windowsHide: true }
    ]]);
  });

  test.each([
    ['missing binary', { code: 'ENOENT', message: 'token=raw-secret' }, 'command_unavailable'],
    ['timeout', { code: 'ETIMEDOUT', stderr: 'token=raw-secret' }, 'command_timed_out'],
    ['nonzero exit', { code: 1, stderr: 'token=raw-secret' }, 'command_failed']
  ])('returns a sanitized %s error without command output', async (_case, failure, code) => {
    const result = await sourceWithRunner({
      async run() { throw failure; }
    }).observe();

    expect(result).toEqual({
      available: false, error: { code, source: 'command' }
    });
    expect(JSON.stringify(result)).not.toContain('raw-secret');
  });

  test('rejects malformed JSON and malformed root records without retaining payload', async () => {
    for (const stdout of ['{definitely not JSON', JSON.stringify({ Self: [] })]) {
      const result = await sourceWithRunner({ async run() { return { stdout }; } }).observe();
      expect(result).toEqual({
        available: false,
        error: { code: 'invalid_status', source: 'command' }
      });
      expect(JSON.stringify(result)).not.toContain('definitely not JSON');
    }
  });

  test('returns Self and healthy peers while preserving decoder peer errors', async () => {
    const result = await sourceWithRunner({
      async run() {
        return {
          stdout: JSON.stringify(status({
            Peer: {
              healthy: device({ ID: 'node-peer', TailscaleIPs: ['100.101.0.2'] }),
              invalid: device({ ID: '', TailscaleIPs: ['100.101.0.3'] })
            }
          }))
        };
      }
    }).observe();

    expect(result).toEqual({
      available: true,
      snapshot: {
        backendState: 'running',
        source: 'tailscale_status_json',
        freshness: {
          observedAt: '2026-08-14T10:00:00.000Z',
          freshUntil: '2026-08-14T10:01:00.000Z',
          state: 'fresh'
        },
        devices: [
          expect.objectContaining({ id: 'node-self', addresses: ['100.64.0.1'] }),
          expect.objectContaining({ id: 'node-peer', addresses: ['100.101.0.2'] })
        ],
        deviceErrors: [{ code: 'invalid_device', source: 'peer' }]
      }
    });
  });
});

function sourceWithRunner(runner: TailscaleStatusCommandRunner) {
  return createCommandTailscaleInventorySource({ now: () => observedAt, runner });
}

function status(overrides: Record<string, unknown> = {}) {
  return { BackendState: 'Running', Peer: {}, Self: device(), ...overrides };
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    ID: 'node-self', HostName: 'os-pc', LastSeen: '2026-08-14T09:59:00Z',
    Online: true, OS: 'linux', Tags: ['tag:developer'], TailscaleIPs: ['100.64.0.1'],
    ...overrides
  };
}
