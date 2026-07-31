import { describe, expect, test } from 'bun:test';
import { PreviewLifecycleController, canTransitionPreviewLifecycle, transitionPreviewLifecycle } from '../server/preview-lifecycle';
import { previewHubLifecycleFromLegacyState, previewHubRecordFromLegacyStatus } from '../src/shared/pull-request-preview-hub-api';
import type { PreviewHubRecord } from '../src/shared/pull-request-preview-hub-api';

const sha = 'a'.repeat(40);
const base: PreviewHubRecord = {
  lifecycle: 'ready', pullRequestNumber: 1, requestedHeadSha: sha,
  repositoryFullName: 'DotNaos/project-space', stateChangedAt: '2026-01-01T00:00:00.000Z', allowedActions: ['start']
};

describe('on-demand Preview lifecycle', () => {
  test('preserves transitional and terminal lifecycle states in the browser contract', () => {
    expect(previewHubLifecycleFromLegacyState('starting', false)).toBe('starting');
    expect(previewHubLifecycleFromLegacyState('stopping', true)).toBe('stopping');
    expect(previewHubLifecycleFromLegacyState('expired', false)).toBe('expired');

    const status = {
      currentHeadSha: sha,
      pullRequestNumber: 1,
      pullRequestState: 'open' as const,
      repositoryFullName: 'DotNaos/project-space',
      requestedSha: sha,
      runningSha: undefined,
      state: 'starting' as const,
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    expect(previewHubRecordFromLegacyStatus(status).allowedActions).toEqual([]);

    expect(previewHubRecordFromLegacyStatus({ ...status, state: 'failed', capacityBlocked: true }).allowedActions).toEqual(['stop']);
    expect(previewHubRecordFromLegacyStatus({
      ...status,
      currentHeadSha: 'b'.repeat(40),
      runningSha: sha,
      state: 'online'
    }).allowedActions).toEqual(['stop']);
  });

  test('keeps offline and online states distinct', () => {
    expect(canTransitionPreviewLifecycle('ready', 'starting')).toBe(true);
    expect(canTransitionPreviewLifecycle('ready', 'online')).toBe(false);
    expect(() => transitionPreviewLifecycle(base, 'online')).toThrow('cannot transition');
  });

  test('does not exceed three online previews and returns explicit capacity choices', async () => {
    const controller = new PreviewLifecycleController(3, {
      isOpenAtHead: async () => true,
      startRuntime: async (record) => ({ previewUrl: `https://pr-${record.pullRequestNumber}.projects.os-home.net`, verifiedRunningHeadSha: record.requestedHeadSha }),
      stopRuntime: async () => undefined
    });
    for (let number = 1; number <= 4; number += 1) await controller.registerReady({ ...base, pullRequestNumber: number });
    for (let number = 1; number <= 3; number += 1) {
      const result = await controller.start({ pullRequestNumber: number, repositoryFullName: base.repositoryFullName, requestedHeadSha: sha });
      expect(result.code).toBe('accepted');
    }
    const full = await controller.start({ pullRequestNumber: 4, repositoryFullName: base.repositoryFullName, requestedHeadSha: sha });
    expect(full.code).toBe('capacity_requires_choice');
    if (full.code === 'capacity_requires_choice') expect(full.online.map((entry) => entry.pullRequestNumber)).toEqual([1, 2, 3]);
    expect(controller.inventory().onlineCount).toBe(3);
  });

  test('rejects a stale replacement confirmation and restores no implicit victim', async () => {
    const controller = new PreviewLifecycleController(1, { isOpenAtHead: async () => true, startRuntime: async (record) => ({ previewUrl: 'https://example.test', verifiedRunningHeadSha: record.requestedHeadSha }), stopRuntime: async () => undefined });
    await controller.registerReady({ ...base, pullRequestNumber: 1 });
    await controller.registerReady({ ...base, pullRequestNumber: 2 });
    await controller.start({ pullRequestNumber: 1, repositoryFullName: base.repositoryFullName, requestedHeadSha: sha });
    const choice = await controller.start({ pullRequestNumber: 2, repositoryFullName: base.repositoryFullName, requestedHeadSha: sha });
    expect(choice.code).toBe('capacity_requires_choice');
    if (choice.code !== 'capacity_requires_choice') return;
    const changed = await controller.start({ pullRequestNumber: 2, repositoryFullName: base.repositoryFullName, requestedHeadSha: sha, inventoryRevision: 'stale', selectedReplacementPullRequestNumber: 1 });
    expect(changed.code).toBe('capacity_requires_choice');
    expect(controller.inventory().previews.find((entry) => entry.pullRequestNumber === 1)?.lifecycle).toBe('online');
  });

  test('prepares a confirmed replacement and restores the selected Preview when target startup fails', async () => {
    const controller = new PreviewLifecycleController(1, {
      isOpenAtHead: async () => true,
      startRuntime: async (record) => {
        if (record.pullRequestNumber === 2) throw new Error('target unhealthy');
        return { previewUrl: 'https://example.test', verifiedRunningHeadSha: record.requestedHeadSha };
      },
      stopRuntime: async () => undefined,
      restoreRuntime: async () => true
    });
    await controller.registerReady({ ...base, pullRequestNumber: 1 });
    await controller.registerReady({ ...base, pullRequestNumber: 2 });
    await controller.start({ pullRequestNumber: 1, repositoryFullName: base.repositoryFullName, requestedHeadSha: sha });
    const inventory = controller.inventory();
    const result = await controller.start({
      pullRequestNumber: 2,
      repositoryFullName: base.repositoryFullName,
      requestedHeadSha: sha,
      inventoryRevision: inventory.inventoryRevision,
      selectedReplacementPullRequestNumber: 1,
      selectedReplacementRepositoryFullName: base.repositoryFullName,
      selectedReplacementHeadSha: sha
    });
    expect(result.code).toBe('operation_failed');
    expect(result.message).toContain('restored');
    expect(controller.inventory().onlineCount).toBe(1);
    expect(controller.inventory().previews.find((entry) => entry.pullRequestNumber === 1)?.lifecycle).toBe('online');
  });

  test('serializes concurrent starts under the global capacity lock', async () => {
    const controller = new PreviewLifecycleController(3, {
      isOpenAtHead: async () => true,
      startRuntime: async (record) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { previewUrl: `https://pr-${record.pullRequestNumber}.projects.os-home.net`, verifiedRunningHeadSha: record.requestedHeadSha };
      }
    });
    for (let number = 1; number <= 5; number += 1) await controller.registerReady({ ...base, pullRequestNumber: number });
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => controller.start({
      pullRequestNumber: index + 1,
      repositoryFullName: base.repositoryFullName,
      requestedHeadSha: sha
    })));
    expect(results.filter((result) => result.code === 'accepted')).toHaveLength(3);
    expect(results.filter((result) => result.code === 'capacity_requires_choice')).toHaveLength(2);
    expect(controller.inventory().onlineCount).toBe(3);
  });

  test('idle shutdown requires trusted activity timestamps', async () => {
    const controller = new PreviewLifecycleController(1, { now: () => new Date('2026-01-02T00:00:00Z'), isOpenAtHead: async () => true, startRuntime: async (record) => ({ previewUrl: 'https://example.test', verifiedRunningHeadSha: record.requestedHeadSha }), stopRuntime: async () => undefined });
    await controller.registerReady({ ...base, pullRequestNumber: 1, lastActivityAt: '2026-01-01T00:00:00Z', lastVerifiedAt: '2026-01-01T00:00:00Z' });
    await controller.start({ pullRequestNumber: 1, repositoryFullName: base.repositoryFullName, requestedHeadSha: sha });
    expect(await controller.idleShutdown(new Date('2026-01-02T00:00:00Z'), 60_000)).toEqual([1]);
    expect(controller.inventory().previews[0]?.lifecycle).toBe('ready');
  });
});
