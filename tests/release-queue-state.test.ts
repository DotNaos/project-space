import { describe, expect, test } from 'bun:test';
import {
  enforcedQueueCommits,
  releaseQueueDecision,
  type PublishedRelease,
  type QueuedMerge,
} from '../scripts/release-queue-state';
import type { UnpublishedReleaseTombstone } from
  '../scripts/release-tombstone';

const published: PublishedRelease = {
  commit: 'a'.repeat(40),
  tag: 'v1.2.3',
  version: '1.2.3',
};

function merge(
  bump: NonNullable<QueuedMerge['bump']>,
  pullRequest: number,
): QueuedMerge {
  return {
    commit: pullRequest.toString(16).padStart(40, '0'),
    bump,
    pullRequest,
  };
}

describe('serial release queue decisions', () => {
  test('keeps enforcement active after the adoption commit is published', () => {
    expect(enforcedQueueCommits({
      alreadyEnforced: true,
      commits: ['next', 'later'],
      enforcementIndex: -1,
    })).toEqual(['next', 'later']);
    expect(enforcedQueueCommits({
      alreadyEnforced: false,
      commits: ['legacy', 'adopt', 'next'],
      enforcementIndex: 1,
    })).toEqual(['adopt', 'next']);
    expect(() => enforcedQueueCommits({
      alreadyEnforced: false,
      commits: ['unowned'],
      enforcementIndex: -1,
    })).toThrow('no release queue enforcement marker');
  });

  test.each([
    ['patch', '1.2.4'],
    ['minor', '1.3.0'],
    ['major', '2.0.0'],
  ] as const)('derives the next %s only after merge', (intent, version) => {
    const item = merge(intent, 10);
    expect(releaseQueueDecision({
      currentMain: item.commit,
      merges: [item],
      published,
      reservations: [],
    })).toEqual({
      bump: intent,
      item,
      kind: 'release',
      tag: `v${version}`,
      version,
    });
  });

  test('always selects the oldest release-bearing merge', () => {
    const none: QueuedMerge = {
      commit: '000000000000000000000000000000000000000b',
      intent: 'none',
      pullRequest: 11,
    };
    const first = merge('patch', 12);
    const second = merge('minor', 13);
    const decision = releaseQueueDecision({
      currentMain: second.commit,
      merges: [none, first, second],
      published,
      reservations: [],
    });
    expect(decision.kind).toBe('release');
    if (decision.kind === 'release') expect(decision.item).toEqual(first);
  });

  test('reuses only the exact durable tag reservation', () => {
    const item = merge('patch', 14);
    expect(releaseQueueDecision({
      currentMain: item.commit,
      merges: [item],
      published,
      reservations: [{ commit: item.commit, tag: 'v1.2.4' }],
    }).kind).toBe('release');
  });

  test('preserves a failed tag and creates one exact catch-up release', () => {
    const failed = merge('minor', 20);
    const repair = merge('patch', 21);
    const policy = merge('patch', 22);
    const tombstone: UnpublishedReleaseTombstone = {
      exhaustedRunId: 100,
      reason: 'windows-x64-source-incompatible',
      schema: 'project-space.unpublished-release-tombstone/v1',
      sourceCommit: failed.commit,
      tag: 'v1.3.0',
      verificationRunId: 101,
      workflowSha256: 'f'.repeat(64),
    };
    expect(releaseQueueDecision({
      currentMain: policy.commit,
      merges: [failed, repair, policy],
      published,
      reservations: [{ commit: failed.commit, tag: 'v1.3.0' }],
      tombstones: [tombstone],
    })).toEqual({
      bump: 'patch',
      item: policy,
      kind: 'release',
      tag: 'v1.3.1',
      version: '1.3.1',
    });
    expect(releaseQueueDecision({
      currentMain: policy.commit,
      merges: [failed, repair, policy],
      published,
      reservations: [
        { commit: failed.commit, tag: 'v1.3.0' },
        { commit: policy.commit, tag: 'v1.3.1' },
      ],
      tombstones: [tombstone],
    }).kind).toBe('release');
  });

  test('uses the strongest queued catch-up bump once', () => {
    const failed = merge('minor', 23);
    const patch = merge('patch', 24);
    const major = merge('major', 25);
    const tombstone: UnpublishedReleaseTombstone = {
      exhaustedRunId: 100,
      reason: 'windows-x64-source-incompatible',
      schema: 'project-space.unpublished-release-tombstone/v1',
      sourceCommit: failed.commit,
      tag: 'v1.3.0',
      verificationRunId: 101,
      workflowSha256: 'f'.repeat(64),
    };
    const decision = releaseQueueDecision({
      currentMain: major.commit,
      merges: [failed, patch, major],
      published,
      reservations: [{ commit: failed.commit, tag: 'v1.3.0' }],
      tombstones: [tombstone],
    });
    expect(decision.kind).toBe('release');
    if (decision.kind === 'release') {
      expect(decision.tag).toBe('v2.0.0');
      expect(decision.item).toEqual(major);
    }
  });

  test('fails closed for incomplete or conflicting tombstone recovery', () => {
    const failed = merge('minor', 26);
    const repair = merge('patch', 27);
    const tombstone: UnpublishedReleaseTombstone = {
      exhaustedRunId: 100,
      reason: 'windows-x64-source-incompatible',
      schema: 'project-space.unpublished-release-tombstone/v1',
      sourceCommit: failed.commit,
      tag: 'v1.3.0',
      verificationRunId: 101,
      workflowSha256: 'f'.repeat(64),
    };
    for (const input of [
      {
        currentMain: repair.commit,
        merges: [],
        reservations: [],
        tombstones: [tombstone],
      },
      {
        currentMain: failed.commit,
        merges: [failed],
        reservations: [{ commit: failed.commit, tag: 'v1.3.0' }],
        tombstones: [tombstone],
      },
      {
        currentMain: repair.commit,
        merges: [failed, repair],
        reservations: [],
        tombstones: [tombstone],
      },
      {
        currentMain: repair.commit,
        merges: [failed, repair],
        reservations: [
          { commit: failed.commit, tag: 'v1.3.0' },
          { commit: failed.commit, tag: 'v1.3.1' },
        ],
        tombstones: [tombstone],
      },
      {
        currentMain: repair.commit,
        merges: [failed, repair],
        reservations: [{ commit: failed.commit, tag: 'v1.3.0' }],
        tombstones: [
          tombstone,
          { ...tombstone, tag: 'v1.3.1' },
        ],
      },
    ]) {
      expect(() => releaseQueueDecision({ ...input, published })).toThrow();
    }
  });

  test.each([
    [[{ commit: 'b'.repeat(40), tag: 'v1.2.4' }]],
    [[{ commit: merge('patch', 15).commit, tag: 'v1.2.5' }]],
    [[
      { commit: merge('patch', 15).commit, tag: 'v1.2.4' },
      { commit: merge('minor', 16).commit, tag: 'v1.3.0' },
    ]],
  ])('fails closed for an ambiguous or conflicting reservation', (reservations) => {
    expect(() => releaseQueueDecision({
      currentMain: merge('patch', 15).commit,
      merges: [merge('patch', 15)],
      published,
      reservations,
    })).toThrow();
  });

  test('deploys current main only after legacy history contains no release intent', () => {
    const current: QueuedMerge = {
      commit: merge('patch', 17).commit,
      intent: 'none',
      pullRequest: 17,
    };
    expect(releaseQueueDecision({
      currentMain: current.commit,
      merges: [current],
      published,
      reservations: [],
    })).toEqual({
      commit: current.commit,
      kind: 'deploy',
      release: published,
    });
  });
});
