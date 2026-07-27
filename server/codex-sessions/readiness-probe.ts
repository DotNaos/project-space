import { resolveCodexBinary } from './binary-resolver';
import { CodexWebSocketTransport } from './websocket-transport';

export type CodexRuntimeReadiness =
  | 'missing'
  | 'runtime-only'
  | 'authorization-required'
  | 'ready';

interface ReadinessTransport {
  call<Result>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal }
  ): Promise<Result>;
  close(): Promise<void>;
  initialize(options?: { signal?: AbortSignal }): Promise<void>;
}

export function createCodexRuntimeReadinessProbe(options: {
  cacheMs?: number;
  launch?(binaryPath: string): Promise<ReadinessTransport> | ReadinessTransport;
  now?(): number;
  resolveBinary?(): string | undefined;
  timeoutMs?: number;
} = {}) {
  const cacheMs = options.cacheMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  const resolveBinary = options.resolveBinary ?? (() => resolveCodexBinary().path);
  const launch = options.launch ?? (() => CodexWebSocketTransport.connect({
    onMessage: () => undefined
  }));
  let cached: { expiresAt: number; value: CodexRuntimeReadiness } | undefined;
  let inFlight: Promise<CodexRuntimeReadiness> | undefined;

  return async function probe(): Promise<CodexRuntimeReadiness> {
    const checkedAt = now();
    if (cached && cached.expiresAt > checkedAt) return cached.value;
    const current = inFlight ?? inspect();
    inFlight = current;
    try {
      const value = await current;
      cached = { expiresAt: checkedAt + cacheMs, value };
      return value;
    } finally {
      if (inFlight === current) inFlight = undefined;
    }
  };

  async function inspect(): Promise<CodexRuntimeReadiness> {
    const binaryPath = resolveBinary();
    if (!binaryPath) return 'missing';
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    deadline.unref?.();
    let transport: ReadinessTransport | undefined;
    let initialized = false;
    try {
      transport = await launch(binaryPath);
      await transport.initialize({ signal: controller.signal });
      initialized = true;
      const result = await transport.call<unknown>(
        'account/read',
        { refreshToken: true },
        { signal: controller.signal }
      );
      return accountReadiness(result);
    } catch {
      return initialized ? 'runtime-only' : 'missing';
    } finally {
      clearTimeout(deadline);
      await transport?.close().catch(() => undefined);
    }
  }
}

function accountReadiness(value: unknown): CodexRuntimeReadiness {
  if (!value || typeof value !== 'object' ||
      !('account' in value) || !('requiresOpenaiAuth' in value) ||
      typeof value.requiresOpenaiAuth !== 'boolean') return 'runtime-only';
  return value.requiresOpenaiAuth === false || value.account !== null
    ? 'ready'
    : 'authorization-required';
}
