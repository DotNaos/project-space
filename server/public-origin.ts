import type { IncomingMessage } from 'node:http';

const defaultPublicOrigin = 'https://projects.os-home.net';
const publicHostPattern = /^(?:localhost|[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])(?::\d{1,5})?$/;

function normalizePublicOrigin(value: string) {
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !publicHostPattern.test(url.host) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function requestPublicOrigin(request: IncomingMessage) {
  const configuredOrigin = process.env.PROJECT_SPACE_PUBLIC_ORIGIN?.trim();
  if (configuredOrigin) {
    const normalized = normalizePublicOrigin(configuredOrigin);
    if (!normalized) {
      throw new Error('PROJECT_SPACE_PUBLIC_ORIGIN must be a plain HTTP or HTTPS origin.');
    }
    return normalized;
  }

  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  const proto = request.headers['x-forwarded-proto'] ??
    ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const firstHost = Array.isArray(host) ? host[0] : String(host).split(',')[0]?.trim();
  const firstProto = Array.isArray(proto) ? proto[0] : String(proto).split(',')[0]?.trim();
  return normalizePublicOrigin(`${firstProto}://${firstHost}`) ?? defaultPublicOrigin;
}
