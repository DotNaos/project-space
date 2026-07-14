export const projectTopologyRefreshIntervalMs = 25_000;
const minimumRefreshYieldMs = 10_000;

export function subscribeProjectTopologyAutoRefresh(
  refresh: () => Promise<unknown> | unknown,
  browserWindow: Pick<Window, 'addEventListener' | 'clearTimeout' | 'removeEventListener' | 'setTimeout'> = window,
  browserDocument: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'> = document,
  clock: () => number = () => Date.now()
) {
  let activeRefresh: Promise<unknown> | undefined;
  let stopped = false;
  let timer: number | undefined;
  const clearTimer = () => {
    if (timer === undefined) return;
    browserWindow.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (delayMs: number) => {
    clearTimer();
    if (stopped || browserDocument.visibilityState !== 'visible') return;
    timer = browserWindow.setTimeout(run, delayMs);
  };
  const run = () => {
    clearTimer();
    if (stopped || browserDocument.visibilityState !== 'visible' || activeRefresh) return;
    const startedAt = clock();
    activeRefresh = Promise.resolve(refresh())
      .catch(() => undefined)
      .finally(() => {
        activeRefresh = undefined;
        schedule(Math.max(
          minimumRefreshYieldMs,
          projectTopologyRefreshIntervalMs - Math.max(0, clock() - startedAt)
        ));
      });
  };
  const refreshOnline = () => run();
  const refreshVisible = () => {
    if (browserDocument.visibilityState === 'visible') run();
    else clearTimer();
  };
  browserWindow.addEventListener('online', refreshOnline);
  browserDocument.addEventListener('visibilitychange', refreshVisible);
  queueMicrotask(run);
  return () => {
    stopped = true;
    clearTimer();
    browserWindow.removeEventListener('online', refreshOnline);
    browserDocument.removeEventListener('visibilitychange', refreshVisible);
  };
}
