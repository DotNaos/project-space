import { describe, expect, test } from 'bun:test';

import {
  projectTopologyRefreshIntervalMs,
  subscribeProjectTopologyAutoRefresh
} from '../../src/features/project-topology/project-topology-auto-refresh';

describe('project topology automatic refresh', () => {
  test('serializes refreshes and pauses its timer while the route is hidden', async () => {
    const windowEvents = new EventTarget();
    const documentEvents = new EventTarget();
    let timerCallback!: () => void;
    let timerDelay = 0;
    let cleared: number | undefined;
    let now = 0;
    let visibilityState: DocumentVisibilityState = 'visible';
    let refreshes = 0;
    const resolvers: Array<() => void> = [];
    const browserWindow = {
      addEventListener: windowEvents.addEventListener.bind(windowEvents),
      clearTimeout(id: number) { cleared = id; },
      removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
      setTimeout(callback: () => void, delay: number) {
        timerCallback = callback;
        timerDelay = delay;
        return 17;
      }
    } as never;
    const browserDocument = {
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
      get visibilityState() { return visibilityState; }
    } as never;
    const unsubscribe = subscribeProjectTopologyAutoRefresh(
      () => new Promise<void>((resolve) => {
        refreshes += 1;
        resolvers.push(resolve);
      }),
      browserWindow,
      browserDocument,
      () => now
    );

    await Promise.resolve();
    expect(refreshes).toBe(1);
    windowEvents.dispatchEvent(new Event('online'));
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(refreshes).toBe(1);
    now = 30_000;
    resolvers.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(timerDelay).toBe(10_000);

    now = 40_000;
    timerCallback();
    expect(refreshes).toBe(2);
    visibilityState = 'hidden';
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    resolvers.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(cleared).toBe(17);

    visibilityState = 'visible';
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(refreshes).toBe(3);

    unsubscribe();
    windowEvents.dispatchEvent(new Event('online'));
    documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(refreshes).toBe(3);
  });
});
