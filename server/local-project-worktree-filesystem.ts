import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export type WorktreeDirectoryEntry = {
  isDirectory: () => boolean;
  name: string;
};

export type WorktreePointerStat = {
  isDirectory: () => boolean;
  isFile: () => boolean;
};

export type LocalProjectWorktreeFileSystem = {
  lstat: (path: string) => Promise<WorktreePointerStat>;
  pathExists: (path: string) => Promise<boolean>;
  readTextFile: (path: string, signal?: AbortSignal) => Promise<string>;
  readdir: (path: string) => Promise<ReadonlyArray<WorktreeDirectoryEntry>>;
};

export const localProjectWorktreeFileSystem: LocalProjectWorktreeFileSystem = {
  lstat,
  async pathExists(path) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  },
  readTextFile: (path, signal) => readFile(path, { encoding: 'utf8', signal }),
  readdir: (path) => readdir(path, { withFileTypes: true })
};

const maxPendingFileSystemProbes = 16;
const fileSystemIds = new WeakMap<LocalProjectWorktreeFileSystem, number>();
let nextFileSystemId = 1;

type FileSystemProbeSubscriber = {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
  signal?: AbortSignal;
};

type PendingFileSystemProbe = {
  subscribers: Set<FileSystemProbeSubscriber>;
};

const pendingFileSystemProbes = new Map<string, PendingFileSystemProbe>();

class FileSystemProbeCapacityError extends Error {
  constructor() {
    super('The worktree filesystem probe capacity is temporarily exhausted.');
    this.name = 'FileSystemProbeCapacityError';
  }
}

function abortReason(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;

  const error = new Error('The worktree inventory was aborted.');
  error.name = 'AbortError';
  return error;
}

export function throwIfWorktreeLoadAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortReason(signal);
}

export function rethrowIfWorktreeLoadAborted(
  error: unknown,
  signal: AbortSignal | undefined
) {
  if (signal?.aborted) throw abortReason(signal);
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    throw error;
  }
}

function fileSystemProbeKey(
  fileSystem: LocalProjectWorktreeFileSystem,
  operation: string,
  path: string
) {
  let fileSystemId = fileSystemIds.get(fileSystem);
  if (!fileSystemId) {
    fileSystemId = nextFileSystemId;
    nextFileSystemId += 1;
    fileSystemIds.set(fileSystem, fileSystemId);
  }
  return `${fileSystemId}\0${operation}\0${resolve(path)}`;
}

export function settleWorktreeFileSystemProbe<T>(
  fileSystem: LocalProjectWorktreeFileSystem,
  operationName: string,
  path: string,
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfWorktreeLoadAborted(signal);
  const key = fileSystemProbeKey(fileSystem, operationName, path);

  let probe = pendingFileSystemProbes.get(key);
  if (!probe) {
    if (pendingFileSystemProbes.size >= maxPendingFileSystemProbes) {
      return Promise.reject(new FileSystemProbeCapacityError());
    }

    probe = { subscribers: new Set() };
    pendingFileSystemProbes.set(key, probe);
    const activeProbe = probe;
    const settleProbe = (result: { error?: unknown; value?: T }) => {
      if (pendingFileSystemProbes.get(key) === activeProbe) {
        pendingFileSystemProbes.delete(key);
      }
      for (const subscriber of activeProbe.subscribers) {
        if (subscriber.signal && subscriber.onAbort) {
          subscriber.signal.removeEventListener('abort', subscriber.onAbort);
        }
        if ('error' in result) subscriber.reject(result.error);
        else subscriber.resolve(result.value);
      }
      activeProbe.subscribers.clear();
    };

    Promise.resolve()
      .then(operation)
      .then(
        (value) => settleProbe({ value }),
        (error: unknown) => settleProbe({ error })
      );
  }

  const activeProbe = probe;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const subscriber: FileSystemProbeSubscriber = {
      reject: rejectPromise,
      resolve: (value) => resolvePromise(value as T),
      signal
    };
    const onAbort = () => {
      if (!activeProbe.subscribers.delete(subscriber)) return;
      signal?.removeEventListener('abort', onAbort);
      rejectPromise(signal ? abortReason(signal) : new Error('The worktree inventory was aborted.'));
    };
    subscriber.onAbort = onAbort;
    activeProbe.subscribers.add(subscriber);

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
  });
}

export async function withWorktreeLoadSignal<T>(
  options: { signal?: AbortSignal; timeoutMs?: number },
  operation: (signal?: AbortSignal) => Promise<T>
) {
  const timeoutMs = options.timeoutMs;
  if (!(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    return operation(options.signal);
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    const error = new Error('The worktree inventory timed out.');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, Math.ceil(timeoutMs));

  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export async function mapWorktreeValuesWithConcurrency<T, R>(
  values: readonly T[],
  worker: (value: T) => Promise<R>,
  signal: AbortSignal | undefined,
  concurrency = 4
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < values.length) {
      throwIfWorktreeLoadAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker())
  );
  return results;
}
