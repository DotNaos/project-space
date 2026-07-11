import { describe, expect, test } from 'bun:test';
import {
  ProjectChatRetentionWorker,
  type ProjectChatIntervalScheduler
} from '../server/project-chat/retention-worker';

class TestScheduler implements ProjectChatIntervalScheduler {
  callback?: () => void;
  cleared = false;

  setInterval(callback: () => void) {
    this.callback = callback;
    return 'retention-timer';
  }

  clearInterval(handle: unknown) {
    expect(handle).toBe('retention-timer');
    this.cleared = true;
  }
}

describe('Project Chat retention worker', () => {
  test('cleans on startup and periodically even without room traffic', async () => {
    const scheduler = new TestScheduler();
    let calls = 0;
    const worker = new ProjectChatRetentionWorker({
      async purgeExpired() {
        calls += 1;
        return 1;
      }
    }, { intervalMs: 1_000, scheduler });

    worker.start();
    await Promise.resolve();
    expect(calls).toBe(1);
    scheduler.callback?.();
    await Promise.resolve();
    expect(calls).toBe(2);
    worker.stop();
    expect(scheduler.cleared).toBe(true);
  });

  test('coalesces overlapping cleanup and reports errors without payloads', async () => {
    let release = () => {};
    let calls = 0;
    let errors = 0;
    const pending = new Promise<number>((_resolve, reject) => {
      release = () => reject(new Error('database details must stay private'));
    });
    const worker = new ProjectChatRetentionWorker({
      async purgeExpired() {
        calls += 1;
        return pending;
      }
    }, { onError: () => { errors += 1; } });

    worker.start();
    const second = worker.runOnce();
    expect(calls).toBe(1);
    release();
    await expect(second).rejects.toThrow();
    await Promise.resolve();
    expect(errors).toBe(1);
    worker.stop();
  });
});
