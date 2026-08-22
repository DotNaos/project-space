import { isIP } from 'node:net';

import type {
  DecodeTailscaleStatusOptions,
  TailscaleDeviceDecodeError,
  TailscaleDeviceObservation,
  TailscaleStatusSnapshot
} from './contracts';

type UnknownRecord = Record<string, unknown>;

/**
 * Decodes a `tailscale status --json` shaped payload without retaining it.
 * A malformed root or Self record fails closed. A malformed peer is isolated
 * as a sanitized per-device error so healthy peers remain useful.
 */
export function decodeTailscaleStatus(
  input: unknown,
  options: DecodeTailscaleStatusOptions
): TailscaleStatusSnapshot {
  const root = requiredRecord(input, 'Tailscale status payload is invalid.');
  if (root.BackendState !== 'Running') {
    throw new Error('Tailscale is not connected.');
  }
  const freshness = decodeFreshness(options);
  const self = decodeRequiredDevice(root.Self, 'Tailscale Self record is invalid.');
  const peers = optionalPeerMap(root.Peer);
  const devices = [self];
  const deviceErrors: TailscaleDeviceDecodeError[] = [];
  const identities = new Set([self.id]);

  for (const peer of Object.values(peers)) {
    const decoded = decodePeer(peer);
    if (!decoded.ok) {
      deviceErrors.push({ code: decoded.code, source: 'peer' });
      continue;
    }
    if (identities.has(decoded.device.id)) {
      deviceErrors.push({ code: 'duplicate_device_id', source: 'peer' });
      continue;
    }
    identities.add(decoded.device.id);
    devices.push(decoded.device);
  }

  return {
    backendState: 'running',
    devices,
    deviceErrors,
    freshness,
    source: 'tailscale_status_json'
  };
}

function decodeFreshness(options: DecodeTailscaleStatusOptions) {
  const observedAt = parseIsoTimestamp(options.observedAt);
  if (!observedAt) throw new Error('Tailscale observation time is invalid.');
  const seconds = options.freshnessSeconds ?? 60;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('Tailscale freshness duration is invalid.');
  }
  return {
    observedAt,
    freshUntil: new Date(Date.parse(observedAt) + seconds * 1_000).toISOString(),
    state: 'fresh' as const
  };
}

function decodeRequiredDevice(value: unknown, error: string): TailscaleDeviceObservation {
  const decoded = decodeDevice(value);
  if (!decoded.ok) throw new Error(error);
  return decoded.device;
}

function decodePeer(value: unknown):
  | { ok: true; device: TailscaleDeviceObservation }
  | { ok: false; code: TailscaleDeviceDecodeError['code'] } {
  return decodeDevice(value);
}

function decodeDevice(value: unknown):
  | { ok: true; device: TailscaleDeviceObservation }
  | { ok: false; code: TailscaleDeviceDecodeError['code'] } {
  if (!isRecord(value)) return { ok: false, code: 'invalid_device' };
  const id = safeIdentifier(value.ID);
  if (!id || typeof value.Online !== 'boolean') return { ok: false, code: 'invalid_device' };
  const addresses = decodeAddresses(value.TailscaleIPs);
  if (!addresses.ok) return addresses;
  return {
    ok: true,
    device: {
      addresses: addresses.addresses,
      id,
      lastSeenAt: optionalTimestamp(value.LastSeen),
      observedName: canonicalDnsDeviceName(value.DNSName) ??
        safeLabel(value.HostName) ?? safeLabel(value.Name),
      online: value.Online,
      os: safeToken(value.OS),
      tags: safeTags(value.Tags)
    }
  };
}

function canonicalDnsDeviceName(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return undefined;
  const firstLabel = value.replace(/\.$/, '').split('.')[0];
  return safeLabel(firstLabel);
}

function decodeAddresses(value: unknown):
  | { ok: true; addresses: readonly string[] }
  | { ok: false; code: 'invalid_network_address' } {
  if (!Array.isArray(value)) return { ok: false, code: 'invalid_network_address' };
  const addresses = [...new Set(value.filter(isTailscaleAddress))].sort();
  return addresses.length > 0
    ? { ok: true, addresses }
    : { ok: false, code: 'invalid_network_address' };
}

function optionalPeerMap(value: unknown): UnknownRecord {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error('Tailscale peer list is invalid.');
  return value;
}

function requiredRecord(value: unknown, message: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}

function safeLabel(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u.test(value) ? value : undefined;
}

function safeToken(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 &&
    /^[A-Za-z0-9._-]+$/.test(value) ? value : undefined;
}

function safeTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string =>
    typeof tag === 'string' && tag.length > 0 && tag.length <= 128 &&
    /^tag:[A-Za-z0-9._-]+$/.test(tag)
  ))].sort();
}

function optionalTimestamp(value: unknown) {
  return typeof value === 'string' ? parseIsoTimestamp(value) : undefined;
}

function parseIsoTimestamp(value: string) {
  if (value.length === 0 || value.length > 64) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function isTailscaleAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return false;
  const family = isIP(value);
  if (family === 4) {
    const [, second] = value.split('.').map(Number);
    return second >= 64 && second <= 127 && value.startsWith('100.');
  }
  return family === 6 && value.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
