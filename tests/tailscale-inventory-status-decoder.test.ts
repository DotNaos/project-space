import { describe, expect, test } from 'bun:test';

import { decodeTailscaleStatus } from '../server/tailscale-inventory/status-decoder';

const observedAt = '2026-08-14T10:00:00Z';

describe('Tailscale status decoder', () => {
  test('uses stable IDs and exact Tailscale addresses, not names or MagicDNS', () => {
    const snapshot = decode(status({
      Self: device({ ID: 'node-self', HostName: 'same-name', TailscaleIPs: ['100.84.1.2'] }),
      Peer: {
        alpha: device({ ID: 'node-a', HostName: 'same-name', TailscaleIPs: ['fd7a:115c:a1e0::2'] }),
        bravo: device({ ID: 'node-b', HostName: 'same-name', TailscaleIPs: ['100.116.159.17'] })
      }
    }));

    expect(snapshot.devices.map(({ id, observedName, addresses }) => ({ id, observedName, addresses })))
      .toEqual([
        { id: 'node-self', observedName: 'same-name', addresses: ['100.84.1.2'] },
        { id: 'node-a', observedName: 'same-name', addresses: ['fd7a:115c:a1e0::2'] },
        { id: 'node-b', observedName: 'same-name', addresses: ['100.116.159.17'] }
      ]);
    expect(snapshot.freshness).toEqual({
      observedAt: '2026-08-14T10:00:00.000Z', freshUntil: '2026-08-14T10:01:00.000Z', state: 'fresh'
    });
  });

  test('keeps the same identity when the numeric address changes', () => {
    const first = decode(status({
      Self: device({ ID: 'node-stable', TailscaleIPs: ['100.64.0.1'] })
    }));
    const second = decode(status({
      Self: device({ ID: 'node-stable', TailscaleIPs: ['100.100.0.1'] })
    }));
    expect(first.devices[0]).toMatchObject({ id: 'node-stable', addresses: ['100.64.0.1'] });
    expect(second.devices[0]).toMatchObject({ id: 'node-stable', addresses: ['100.100.0.1'] });
  });

  test('fails the whole snapshot for a malformed root or Self identity', () => {
    expect(() => decode([])).toThrow('status payload is invalid');
    expect(() => decode(status({ Self: device({ ID: '' }) })))
      .toThrow('Self record is invalid');
    expect(() => decode(status({ Self: device(), Peer: [] })))
      .toThrow('peer list is invalid');
  });

  test('fails closed when the local provider is not connected', () => {
    expect(() => decode(status({ BackendState: 'Stopped' })))
      .toThrow('Tailscale is not connected.');
  });

  test('keeps only exact numeric Tailscale IPs and rejects a device with none', () => {
    const accepted = decode(status({
      Self: device({ TailscaleIPs: ['100.100.0.1', '100.100.0.1', 'fd7a:115c:a1e0::1'] })
    }));
    expect(accepted.devices[0]?.addresses).toEqual(['100.100.0.1', 'fd7a:115c:a1e0::1']);

    for (const address of ['os-pc.example.ts.net', '10.0.0.1', '192.168.1.2', '203.0.113.2', 'fd00::1']) {
      expect(() => decode(status({ Self: device({ TailscaleIPs: [address] }) })))
        .toThrow('Self record is invalid');
    }
  });

  test('preserves offline truth and only a valid LastSeen timestamp', () => {
    const snapshot = decode(status({
      Self: device({ Online: false, LastSeen: '2026-08-13T12:34:56Z' }),
      Peer: { invalidLastSeen: device({ ID: 'node-peer', LastSeen: 'not a time' }) }
    }));
    expect(snapshot.devices).toMatchObject([
      { id: 'node-self', online: false, lastSeenAt: '2026-08-13T12:34:56.000Z' },
      { id: 'node-peer', online: true }
    ]);
    expect(snapshot.devices[1]?.lastSeenAt).toBeUndefined();
  });

  test('drops hostile labels and tags rather than carrying raw provider text', () => {
    const snapshot = decode(status({
      Self: device({
        HostName: '<img src=x onerror=alert(1)>', OS: 'linux; rm -rf /',
        Tags: ['tag:trusted', 'tag:<script>', 'tag:trusted', 'tag:ops-team']
      })
    }));
    expect(snapshot.devices[0]).toMatchObject({
      id: 'node-self', tags: ['tag:ops-team', 'tag:trusted']
    });
    expect(snapshot.devices[0]?.observedName).toBeUndefined();
    expect(snapshot.devices[0]?.os).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('<img');
    expect(JSON.stringify(snapshot)).not.toContain('rm -rf');
  });

  test('isolates malformed peers as sanitized errors while healthy peers survive', () => {
    const snapshot = decode(status({
      Self: device(),
      Peer: {
        healthy: device({ ID: 'node-healthy', TailscaleIPs: ['100.101.0.2'] }),
        missingId: device({ ID: '' }),
        badAddress: device({ ID: 'node-bad-address', TailscaleIPs: ['192.0.2.2'] }),
        duplicate: device({ ID: 'node-healthy', TailscaleIPs: ['100.101.0.3'] }),
        notAnObject: 'untrusted payload'
      }
    }));
    expect(snapshot.devices.map((item) => item.id)).toEqual(['node-self', 'node-healthy']);
    expect(snapshot.deviceErrors).toEqual([
      { code: 'invalid_device', source: 'peer' },
      { code: 'invalid_network_address', source: 'peer' },
      { code: 'duplicate_device_id', source: 'peer' },
      { code: 'invalid_device', source: 'peer' }
    ]);
    expect(JSON.stringify(snapshot.deviceErrors)).not.toContain('untrusted payload');
  });
});

function status(overrides: Record<string, unknown>) {
  return { BackendState: 'Running', Peer: {}, Self: device(), ...overrides };
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    ID: 'node-self', HostName: 'os-pc', LastSeen: '2026-08-14T09:59:00Z',
    Online: true, OS: 'linux', Tags: ['tag:developer'], TailscaleIPs: ['100.64.0.1'],
    ...overrides
  };
}

function options() {
  return { observedAt };
}

function decode(input: unknown) {
  return decodeTailscaleStatus(input, options());
}
