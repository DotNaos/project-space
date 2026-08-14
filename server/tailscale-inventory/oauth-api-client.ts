import type {
  TailscaleDeviceDecodeError,
  TailscaleDeviceObservation,
  TailscaleStatusSnapshot
} from './contracts';
import { isTailscaleAddress } from './status-decoder';
import type {
  TailscaleInventorySourceErrorCode,
  TailscaleInventorySourceResult
} from './source';

export const tailscaleOAuthTokenUrl = 'https://api.tailscale.com/api/v2/oauth/token';
export const tailscaleDevicesUrl = 'https://api.tailscale.com/api/v2/tailnet/-/devices';
export const tailscaleInventoryScope = 'devices:core:read';

const tokenResponseLimitBytes = 64 * 1024;
const inventoryResponseLimitBytes = 4 * 1024 * 1024;
const tokenTimeoutMs = 7_000;
const inventoryTimeoutMs = 10_000;

export interface TailscaleOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface TailscaleApiFetch {
  (url: string, init: RequestInit): Promise<Response>;
}

export function createTailscaleOAuthApiClient(options: {
  fetch?: TailscaleApiFetch;
  freshnessSeconds?: number;
  now?: () => Date;
} = {}) {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const freshnessSeconds = options.freshnessSeconds ?? 60;

  return {
    async observe(credentials: TailscaleOAuthCredentials): Promise<TailscaleInventorySourceResult> {
      if (!validCredentials(credentials)) return unavailable('credentials_invalid');
      const token = await requestToken(fetch, credentials);
      if (!token.ok) return unavailable(token.code);
      return requestDevices(fetch, token.accessToken, now(), freshnessSeconds);
    }
  };
}

async function requestToken(
  fetch: TailscaleApiFetch,
  credentials: TailscaleOAuthCredentials
): Promise<{ ok: true; accessToken: string } | { ok: false; code: TailscaleInventorySourceErrorCode }> {
  const signal = AbortSignal.timeout(tokenTimeoutMs);
  let response: Response;
  try {
    response = await fetch(tailscaleOAuthTokenUrl, {
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: 'client_credentials',
        scope: tailscaleInventoryScope
      }),
      credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      method: 'POST',
      redirect: 'error',
      signal
    });
  } catch (error) {
    return { ok: false, code: isTimeout(signal, error) ? 'api_timed_out' : 'api_unavailable' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'credentials_invalid' };
  }
  if (!response.ok || response.status !== 200) return { ok: false, code: 'api_unavailable' };
  try {
    const payload = asRecord(JSON.parse(await readBoundedText(response, tokenResponseLimitBytes)));
    const accessToken = safeSecret(payload.access_token, 8_192);
    const tokenType = typeof payload.token_type === 'string' ? payload.token_type.toLowerCase() : '';
    const expiresIn = Number(payload.expires_in);
    const scopeWasReturned = typeof payload.scope === 'string';
    const scopes = scopeWasReturned
      ? new Set((payload.scope as string).split(/\s+/).filter(Boolean)) : new Set<string>();
    if (!accessToken || tokenType !== 'bearer' || !Number.isFinite(expiresIn) ||
      expiresIn <= 0 || expiresIn > 3_600 ||
      (scopeWasReturned && !scopes.has(tailscaleInventoryScope))) {
      return {
        ok: false,
        code: scopeWasReturned ? 'scope_insufficient' : 'invalid_api_response'
      };
    }
    return { ok: true, accessToken };
  } catch (error) {
    return { ok: false, code: isTooLarge(error) ? 'api_response_too_large' : 'invalid_api_response' };
  }
}

async function requestDevices(
  fetch: TailscaleApiFetch,
  accessToken: string,
  observed: Date,
  freshnessSeconds: number
): Promise<TailscaleInventorySourceResult> {
  const signal = AbortSignal.timeout(inventoryTimeoutMs);
  let response: Response;
  try {
    response = await fetch(tailscaleDevicesUrl, {
      credentials: 'omit',
      headers: { Authorization: `Bearer ${accessToken}` },
      method: 'GET',
      redirect: 'error',
      signal
    });
  } catch (error) {
    return unavailable(isTimeout(signal, error) ? 'api_timed_out' : 'api_unavailable');
  }
  if (response.status === 401) return unavailable('credentials_invalid');
  if (response.status === 403) return unavailable('scope_insufficient');
  if (!response.ok || response.status !== 200) return unavailable('api_unavailable');
  try {
    const payload = JSON.parse(await readBoundedText(response, inventoryResponseLimitBytes));
    return { available: true, snapshot: decodeApiDevices(payload, observed, freshnessSeconds) };
  } catch (error) {
    return unavailable(isTooLarge(error) ? 'api_response_too_large' : 'invalid_api_response');
  }
}

export function decodeApiDevices(
  input: unknown,
  observed: Date,
  freshnessSeconds = 60
): TailscaleStatusSnapshot {
  const root = asRecord(input);
  if (!Array.isArray(root.devices) || !Number.isSafeInteger(freshnessSeconds) || freshnessSeconds <= 0) {
    throw new Error('Tailscale API device inventory is invalid.');
  }
  const observedAt = validDate(observed);
  const devices: TailscaleDeviceObservation[] = [];
  const deviceErrors: TailscaleDeviceDecodeError[] = [];
  const identities = new Set<string>();
  for (const raw of root.devices) {
    const decoded = decodeApiDevice(raw);
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
    deviceErrors,
    devices,
    freshness: {
      freshUntil: new Date(observedAt.getTime() + freshnessSeconds * 1_000).toISOString(),
      observedAt: observedAt.toISOString(),
      state: 'fresh'
    },
    source: 'tailscale_api_devices'
  };
}

function decodeApiDevice(value: unknown):
  | { ok: true; device: TailscaleDeviceObservation }
  | { ok: false; code: TailscaleDeviceDecodeError['code'] } {
  if (!isRecord(value)) return { ok: false, code: 'invalid_device' };
  const id = safeIdentifier(value.id);
  if (!id || typeof value.online !== 'boolean') return { ok: false, code: 'invalid_device' };
  if (!Array.isArray(value.addresses)) return { ok: false, code: 'invalid_network_address' };
  const addresses = [...new Set(value.addresses.filter(isTailscaleAddress))].sort();
  if (addresses.length === 0) return { ok: false, code: 'invalid_network_address' };
  return {
    ok: true,
    device: {
      addresses,
      id,
      ...(safeTimestamp(value.lastSeen) ? { lastSeenAt: safeTimestamp(value.lastSeen) } : {}),
      ...(safeLabel(value.name) ?? safeLabel(value.hostname)
        ? { observedName: safeLabel(value.name) ?? safeLabel(value.hostname) }
        : {}),
      online: value.online,
      ...(safeToken(value.os) ? { os: safeToken(value.os) } : {}),
      tags: safeTags(value.tags)
    }
  };
}

function validCredentials(value: TailscaleOAuthCredentials) {
  return safeSecret(value.clientId, 512) !== undefined &&
    safeSecret(value.clientSecret, 2_048) !== undefined;
}

function safeSecret(value: unknown, max: number) {
  return typeof value === 'string' && value === value.trim() && value.length >= 8 &&
    value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function safeIdentifier(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
    ? value : undefined;
}

function safeLabel(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function safeToken(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value)
    ? value : undefined;
}

function safeTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string =>
    typeof tag === 'string' && /^tag:[A-Za-z0-9._-]{1,128}$/.test(tag)
  ))].sort();
}

function safeTimestamp(value: unknown) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function validDate(value: Date) {
  if (!Number.isFinite(value.getTime())) throw new Error('Tailscale API observation time is invalid.');
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Tailscale API response is invalid.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBoundedText(response: Response, limit: number) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new ResponseTooLargeError();
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new ResponseTooLargeError();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

function unavailable(code: TailscaleInventorySourceErrorCode): TailscaleInventorySourceResult {
  return { available: false, error: { code, source: 'api' } };
}

function isTimeout(signal: AbortSignal, error: unknown) {
  return signal.aborted || (isRecord(error) && error.name === 'AbortError');
}

function isTooLarge(error: unknown) {
  return error instanceof ResponseTooLargeError;
}

class ResponseTooLargeError extends Error {}
