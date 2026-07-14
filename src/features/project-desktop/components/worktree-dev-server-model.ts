import type { WorktreeDevServerRecord } from '../../../shared/project-space-api';

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
    !server.verifiedAt
  ) {
    return undefined;
  }

  try {
    const url = registeredDevServerUrl(server);
    if (!url) return undefined;
    const verifiedAt = Date.parse(server.verifiedAt);
    const ageMs = now - verifiedAt;
    return ageMs >= -5_000 && ageMs <= 30_000 ? url : undefined;
  } catch {
    return undefined;
  }
}
