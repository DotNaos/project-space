import type {
  CodexSessionApprovalRequest,
  CodexSessionBrowserRequest,
  CodexSessionBrowserResult,
  CodexSessionContinueRequest,
  CodexSessionInspectResult,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionListResult,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionSettingsRequest,
  CodexSessionsClient,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from '../shared/codex-sessions-api';
import { CODEX_SESSION_LIST_DEADLINE_MS } from '../shared/codex-session-inventory-window';

export class CodexSessionsRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'CodexSessionsRequestError';
  }
}

export interface CodexSessionsClientOptions {
  authToken?: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
  getAuthToken?: () => Promise<string | null> | string | null;
  listTimeoutMs?: number;
  streamReconnectDelayMs?: number;
}

export function createCodexSessionsClient(
  options: CodexSessionsClientOptions = {}
): CodexSessionsClient {
  const baseUrl = safeBaseUrl(options.baseUrl);
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;

  async function authHeaders(accept = 'application/json') {
    const token = cleanAuthToken(
      options.getAuthToken ? await options.getAuthToken() : options.authToken
    );
    return {
      Accept: accept,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  async function request<T>(path: string, init: RequestInit = {}) {
    const response = await fetchImplementation(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(await authHeaders()),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers
      }
    });
    return readResponse<T>(response);
  }

  async function listRequest(path: string) {
    const controller = new AbortController();
    const configuredTimeout = options.listTimeoutMs ?? CODEX_SESSION_LIST_DEADLINE_MS + 2_000;
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : CODEX_SESSION_LIST_DEADLINE_MS + 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request<CodexSessionListResult>(path, { signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new CodexSessionsRequestError(
              'request_timeout',
              'Codex inventory check timed out.',
              503
            );
            reject(error);
            controller.abort(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function mutation<T extends { machineId: string; operationId: string }>(
    path: string,
    input: T
  ) {
    return request<CodexSessionOperationResult>(pathWithMachine(path, input.machineId), {
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': input.operationId },
      method: 'POST'
    });
  }

  function threadMutation<
    T extends { machineId: string; operationId: string; threadId: string }
  >(
    operation: string,
    input: T
  ) {
    const { threadId, ...body } = input;
    return mutation(
      `/api/codex/sessions/${encodeURIComponent(threadId)}/${operation}`,
      body
    );
  }

  return {
    approve(input: CodexSessionApprovalRequest) {
      return threadMutation('approval', input);
    },
    browser(input: CodexSessionBrowserRequest) {
      const path = pathWithMachine(
        `/api/codex/sessions/${encodeURIComponent(input.threadId)}/browser`,
        input.machineId
      );
      return request<CodexSessionBrowserResult>(input.afterImageRevision
        ? `${path}&afterImageRevision=${encodeURIComponent(input.afterImageRevision)}`
        : path);
    },
    continue(input: CodexSessionContinueRequest) {
      return threadMutation('continue', input);
    },
    interrupt(input: CodexSessionInterruptRequest) {
      return threadMutation('interrupt', input);
    },
    inspect(input) {
      return request<CodexSessionInspectResult>(pathWithMachine(
        `/api/codex/sessions/${encodeURIComponent(input.threadId)}/inspect`,
        input.machineId
      ));
    },
    list(input: CodexSessionListRequest) {
      const query = new URLSearchParams({ machineId: input.machineId });
      if (input.includeArchived) query.set('includeArchived', 'true');
      if (input.search) query.set('search', input.search);
      return listRequest(`/api/codex/sessions?${query}`);
    },
    read(input: CodexSessionReadRequest) {
      return request<CodexSessionReadResult>(pathWithMachine(
        `/api/codex/sessions/${encodeURIComponent(input.threadId)}`,
        input.machineId
      ));
    },
    settings(input: CodexSessionSettingsRequest) {
      return threadMutation('settings', input);
    },
    respondToUserInput(input: CodexSessionUserInputResponse) {
      return threadMutation('input', input);
    },
    subscribe(input, onEvent, onError) {
      const controller = new AbortController();
      void (async () => {
        let lastEventId = Number.isSafeInteger(input.afterSequence) && (input.afterSequence ?? 0) >= 0
          ? String(input.afterSequence)
          : '';
        while (!controller.signal.aborted) {
          try {
            const response = await fetchImplementation(
              `${baseUrl}${pathWithMachine(
                `/api/codex/sessions/${encodeURIComponent(input.threadId)}/stream`,
                input.machineId
              )}`,
              {
                headers: {
                  ...(await authHeaders('text/event-stream')),
                  ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {})
                },
                signal: controller.signal
              }
            );
            if (!response.ok || !response.body) {
              await readResponse(response);
              throw new Error('Codex sessions returned an invalid live stream.');
            }
            for await (const event of serverEvents(response.body)) {
              if (controller.signal.aborted || !event.data) continue;
              const parsed = JSON.parse(event.data) as CodexSessionStreamEvent;
              lastEventId = event.id || parsed.eventId || lastEventId;
              onEvent(parsed);
            }
          } catch (error) {
            if (!controller.signal.aborted) onError?.(error);
          }
          if (!controller.signal.aborted) {
            await abortableDelay(options.streamReconnectDelayMs ?? 1_000, controller.signal);
          }
        }
      })();
      return () => controller.abort();
    }
  };
}

function pathWithMachine(path: string, machineId: string) {
  const query = new URLSearchParams({ machineId });
  return `${path}?${query}`;
}

function safeBaseUrl(value = '') {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//')) throw new Error('Codex sessions base URL is invalid.');
    return trimmed.replace(/\/+$/, '');
  }
  const url = new URL(trimmed);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Codex sessions base URL must be an HTTP(S) URL without credentials.');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (url.protocol === 'http:' && !loopback && !isTailscaleHost(host)) {
    throw new Error('Codex sessions requires HTTPS outside local or Tailscale servers.');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function isTailscaleHost(hostname: string) {
  if (hostname.endsWith('.ts.net')) return true;
  const parts = hostname.split('.').map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    parts[1]! >= 64 &&
    parts[1]! <= 127
  );
}

function cleanAuthToken(value: string | null | undefined) {
  const token = value?.trim() ?? '';
  if (/[\r\n]/.test(token)) throw new Error('Codex sessions auth token is invalid.');
  return token;
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => undefined) as
    | { error?: { code?: string; message?: string } }
    | T
    | undefined;
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? payload.error
      : undefined;
    throw new CodexSessionsRequestError(
      error?.code ?? 'request_failed',
      error?.message ?? `Codex sessions request failed with ${response.status}.`,
      response.status
    );
  }
  if (payload === undefined) {
    throw new CodexSessionsRequestError(
      'invalid_response',
      'Codex sessions returned an invalid response.',
      response.status
    );
  }
  return payload as T;
}

interface ServerEvent {
  data: string;
  event: string;
  id: string;
}

export async function* serverEvents(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ServerEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split('\n').filter((line) => !line.startsWith(':'));
        const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const id = lines.find((line) => line.startsWith('id:'))?.slice(3).trim() ?? '';
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield { data, event, id };
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal) {
  if (delayMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
