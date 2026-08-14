import { decodeTailscaleStatus } from './status-decoder';
import type {
  TailscaleInventorySource,
  TailscaleInventorySourceErrorCode,
  TailscaleInventorySourceResult
} from './source';

/** Fixed, deployment-local collector endpoint. It is not caller configurable. */
export const tailscaleStatusProxyUrl = 'http://tailscale-status:4180/v1/status';
export const tailscaleStatusProxyTimeoutMs = 3_000;
export const tailscaleStatusProxyResponseLimitBytes = 128 * 1024;

export interface TailscaleStatusProxyFetch {
  (url: typeof tailscaleStatusProxyUrl, init: RequestInit): Promise<Response>;
}

export interface ProxyTailscaleInventorySourceOptions {
  fetch?: TailscaleStatusProxyFetch;
  freshnessSeconds?: number;
  now?: () => Date;
}

/**
 * Reads only the local status collector. The endpoint, method, redirect policy,
 * timeout and body bound are fixed so web requests cannot turn this into a
 * general outbound proxy.
 */
export function createProxyTailscaleInventorySource(
  options: ProxyTailscaleInventorySourceOptions = {}
): TailscaleInventorySource {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return {
    async observe(): Promise<TailscaleInventorySourceResult> {
      const signal = AbortSignal.timeout(tailscaleStatusProxyTimeoutMs);
      let response: Response;
      try {
        response = await fetch(tailscaleStatusProxyUrl, {
          credentials: 'omit',
          method: 'GET',
          redirect: 'error',
          signal
        });
      } catch (error) {
        return unavailable(isTimeout(signal, error) ? 'proxy_timed_out' : 'proxy_unavailable');
      }
      if (!response.ok || response.status !== 200) return unavailable('proxy_unavailable');

      let payload: unknown;
      try {
        payload = JSON.parse(await readBoundedText(response)) as unknown;
      } catch (error) {
        return unavailable(isTimeout(signal, error)
          ? 'proxy_timed_out'
          : isResponseTooLarge(error) ? 'proxy_response_too_large' : 'invalid_status');
      }

      try {
        return {
          available: true,
          snapshot: decodeTailscaleStatus(payload, {
            freshnessSeconds: options.freshnessSeconds,
            observedAt: now().toISOString()
          })
        };
      } catch {
        return unavailable('invalid_status');
      }
    }
  };
}

async function readBoundedText(response: Response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > tailscaleStatusProxyResponseLimitBytes) {
    throw new ResponseTooLargeError();
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > tailscaleStatusProxyResponseLimitBytes) throw new ResponseTooLargeError();
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
  return { available: false, error: { code, source: 'proxy' } };
}

function isTimeout(signal: AbortSignal, error: unknown) {
  return signal.aborted || (typeof error === 'object' && error !== null &&
    'name' in error && error.name === 'AbortError');
}

function isResponseTooLarge(error: unknown) {
  return error instanceof ResponseTooLargeError;
}

class ResponseTooLargeError extends Error {}
