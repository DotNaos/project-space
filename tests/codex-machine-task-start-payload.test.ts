import { describe, expect, test } from 'bun:test';

import {
  memoryStore,
  request,
  service,
  threadId
} from './fixtures/codex-machine-tasks-service';

describe('Codex machine-task immutable start payload', () => {
  test('keeps a legacy reservation uncertain when its original payload is unavailable', async () => {
    const store = memoryStore();
    await service({
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request);
    const legacy = store.operations.get(request.operationId);
    if (!legacy) throw new Error('Expected a reserved start.');
    delete (legacy as { startPayload?: unknown }).startPayload;

    const result = await service({ store }).start({ userId: 'user-owner' }, request);

    expect(result).toEqual(expect.objectContaining({
      operationId: request.operationId,
      reconcile: 'required',
      state: 'uncertain',
      target: expect.objectContaining({ connector: expect.objectContaining({ generation: 7 }) })
    }));
  });

  test('reuses the original resolved issue payload while reconciling', async () => {
    const store = memoryStore();
    const original = {
      branch: 'issue-262-original',
      commit: 'a'.repeat(40),
      issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
      repository: { id: 'R_original', nameWithOwner: 'DotNaos/project-space' }
    };
    await service({
      issue: async () => original,
      start: async () => ({ state: 'uncertain' }),
      store
    }).start({ userId: 'user-owner' }, request);

    let issueCalls = 0;
    let retriedPayload: typeof original | undefined;
    const result = await service({
      issue: async () => {
        issueCalls += 1;
        return { ...original, branch: 'issue-262-changed', commit: 'b'.repeat(40) };
      },
      start: async (input) => {
        retriedPayload = {
          branch: input.branch,
          commit: input.commit,
          issue: input.issue,
          repository: input.repository
        };
        return { state: 'confirmed', threadId, worktreeId: 'wt_original' };
      },
      store
    }).start({ userId: 'user-owner' }, request);

    expect(issueCalls).toBe(0);
    expect(retriedPayload).toEqual(original);
    expect(result).toEqual(expect.objectContaining({ state: 'confirmed' }));
  });
});
