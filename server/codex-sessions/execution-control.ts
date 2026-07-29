export function waitForCodexExecution<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return promise;
  try {
    throwIfCodexExecutionCancelled(signal);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(codexExecutionCancelledError(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

export function throwIfCodexExecutionCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw codexExecutionCancelledError(signal);
}

function codexExecutionCancelledError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('The Codex session command was cancelled.');
}
