import { describe, expect, test } from 'bun:test';

import {
  createProjectChatProfileGenerationGuard,
  runProjectChatProfileMutation
} from '../src/features/project-chat/project-chat-model';

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('Project Chat profile refresh ordering', () => {
  test('reconciles a successful save before treating its response as authoritative', async () => {
    const guard = createProjectChatProfileGenerationGuard();
    const save = deferred<string>();
    const beforeSave = guard.captureRefresh();
    let visibleProfile = 'initial-profile';
    let reconciliations = 0;
    const mutation = runProjectChatProfileMutation(
      guard,
      () => save.promise,
      async () => {
        reconciliations += 1;
        expect(guard.canApplyRefresh(guard.captureRefresh(), 3)).toBe(true);
        visibleProfile = 'newer-cross-client-profile';
        return true;
      }
    );
    const duringSave = guard.captureRefresh();

    expect(guard.canApplyRefresh(beforeSave, 1)).toBe(false);
    expect(guard.canApplyRefresh(duringSave, 1)).toBe(false);
    save.resolve('older-delayed-save-response');

    const outcome = await mutation;
    expect(outcome).toEqual({
      applyResult: false,
      result: 'older-delayed-save-response'
    });
    if (outcome.applyResult) {
      visibleProfile = outcome.result;
    }
    expect(reconciliations).toBe(1);
    expect(visibleProfile).toBe('newer-cross-client-profile');
    expect(guard.canApplyRefresh(duringSave, 3)).toBe(false);
    expect(guard.canApplyRefresh(guard.captureRefresh(), 3)).toBe(true);
  });

  test('uses the save response only when authoritative reconciliation fails', async () => {
    const guard = createProjectChatProfileGenerationGuard();

    await expect(runProjectChatProfileMutation(
      guard,
      async () => 'saved-profile',
      async () => false
    )).resolves.toEqual({
      applyResult: true,
      result: 'saved-profile'
    });
  });

  test('reconciles immediately after an ambiguous failed save and rejects its online reload', async () => {
    const guard = createProjectChatProfileGenerationGuard();
    const save = deferred<string>();
    const saveFailure = new Error('profile response was lost');
    let reconciliations = 0;
    const mutation = runProjectChatProfileMutation(
      guard,
      () => save.promise,
      async () => {
        reconciliations += 1;
        const authoritativeRefresh = guard.captureRefresh();
        expect(guard.canApplyRefresh(authoritativeRefresh, 2)).toBe(true);
        return true;
      }
    );
    const concurrentOnlineReload = guard.captureRefresh();
    expect(guard.canApplyRefresh(concurrentOnlineReload, 1)).toBe(false);

    save.reject(saveFailure);

    await expect(mutation).rejects.toBe(saveFailure);
    expect(reconciliations).toBe(1);
    expect(guard.canApplyRefresh(concurrentOnlineReload, 2)).toBe(false);
    expect(guard.canApplyRefresh(guard.captureRefresh(), 2)).toBe(true);
  });

  test('preserves the profile failure if the recovery request also fails', async () => {
    const guard = createProjectChatProfileGenerationGuard();
    const saveFailure = new Error('profile save failed');

    await expect(runProjectChatProfileMutation(
      guard,
      async () => { throw saveFailure; },
      async () => { throw new Error('reconciliation failed'); }
    )).rejects.toBe(saveFailure);
    expect(guard.canApplyRefresh(guard.captureRefresh(), 1)).toBe(true);
  });

  test('rejects an older post-save refresh that resolves after a newer one', async () => {
    const guard = createProjectChatProfileGenerationGuard();
    const mutation = guard.beginMutation();
    expect(guard.finishMutation(mutation)).toBe(true);
    const olderPoll = guard.captureRefresh();
    const newerReconciliation = guard.captureRefresh();

    expect(guard.canApplyRefresh(newerReconciliation, 4)).toBe(true);
    expect(guard.canApplyRefresh(olderPoll, 3)).toBe(false);
    expect(guard.acceptProfileRevision(2)).toBe(false);
    expect(guard.acceptProfileRevision(4)).toBe(true);
  });

  test('uses refresh request order when two responses carry the same revision', () => {
    const guard = createProjectChatProfileGenerationGuard();
    const olderPoll = guard.captureRefresh();
    const newerPoll = guard.captureRefresh();

    expect(guard.canApplyRefresh(newerPoll, 0)).toBe(false);
    expect(guard.canApplyRefresh(newerPoll, 2)).toBe(true);
    expect(guard.canApplyRefresh(olderPoll, 2)).toBe(false);
  });
});
