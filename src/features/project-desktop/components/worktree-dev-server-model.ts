import type { WorktreeDevServerRecord } from '../../../shared/project-space-api';

export const devServerFreshnessFutureToleranceMs = 5_000;
export const devServerFreshnessMaxAgeMs = 30_000;

export function isFreshDevServerTimestamp(value: string | undefined, now = Date.now()) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = now - timestamp;
  return ageMs >= -devServerFreshnessFutureToleranceMs && ageMs <= devServerFreshnessMaxAgeMs;
}

export function registeredDevServerUrl(server: WorktreeDevServerRecord | undefined) {
  if (!server?.tailscaleUrl || !server.tailscaleIPv4 || !server.publicPort) return undefined;
  try {
    const url = new URL(server.tailscaleUrl);
    const octets = server.tailscaleIPv4.split('.').map(Number);
    const isTailscaleIPv4 =
      octets.length === 4 &&
      octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
      octets[0] === 100 &&
      octets[1]! >= 64 &&
      octets[1]! <= 127;
    const matchesExposure =
      url.protocol === 'http:' &&
      url.hostname === server.tailscaleIPv4 &&
      Number(url.port) === server.publicPort &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '';

    return isTailscaleIPv4 && matchesExposure ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function visibleTailscaleUrl(
  server: WorktreeDevServerRecord | undefined,
  now = Date.now()
) {
  if (
    server?.state !== 'running' ||
    !isFreshDevServerTimestamp(server.verifiedAt, now)
  ) {
    return undefined;
  }

  try {
    const url = registeredDevServerUrl(server);
    if (!url) return undefined;
    return url;
  } catch {
    return undefined;
  }
}
