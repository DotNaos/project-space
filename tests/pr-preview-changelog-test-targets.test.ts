import { describe, expect, test } from 'bun:test';

import {
  pullRequestChangelogTestTargetPresentation,
  pullRequestChangelogTestTargetsSchema,
  type PullRequestChangelogTestTargetsSnapshot
} from '../src/shared/pr-preview-changelog-test-targets';
import type { PullRequestChangelogIdentity } from '../src/shared/pr-preview-changelog-api';

const identity: PullRequestChangelogIdentity = {
  headSha: 'a'.repeat(40),
  pullRequestNumber: 398,
  repositoryFullName: 'DotNaos/project-space'
};

function snapshot(
  targets: PullRequestChangelogTestTargetsSnapshot['targets']
): PullRequestChangelogTestTargetsSnapshot {
  return {
    identity,
    schema: pullRequestChangelogTestTargetsSchema,
    targets
  };
}

describe('pull request changelog test targets', () => {
  test('defaults every deployment link to unavailable and withholds live data', () => {
    const targets = pullRequestChangelogTestTargetPresentation(identity);

    expect(targets).toHaveLength(4);
    expect(targets.every((target) => target.state === 'unavailable')).toBe(
      true
    );
    expect(targets.at(-1)).toMatchObject({
      kind: 'dev-server',
      state: 'unavailable'
    });
  });

  test('accepts only exact-revision public Project Space deployment links', () => {
    const targets = pullRequestChangelogTestTargetPresentation(
      identity,
      snapshot([
        {
          headSha: identity.headSha,
          kind: 'full-preview',
          state: 'available',
          url: 'https://pr-398.projects.os-home.net/',
          verifiedAt: '2026-07-28T08:00:00Z'
        },
        {
          kind: 'mobile-prototype',
          reasonCode: 'not-deployed',
          state: 'unavailable'
        }
      ])
    );

    expect(targets[0]).toMatchObject({
      href: 'https://pr-398.projects.os-home.net/',
      kind: 'full-preview',
      state: 'available'
    });
    expect(targets[1]).toMatchObject({
      kind: 'mobile-prototype',
      state: 'unavailable'
    });
    expect(targets[2]).toMatchObject({
      kind: 'desktop-prototype',
      state: 'unavailable'
    });
  });

  test('fails all links closed when identity, provenance, or URL is unsafe', () => {
    const wrongHead = snapshot([
      {
        headSha: 'b'.repeat(40),
        kind: 'full-preview',
        state: 'available',
        url: 'https://pr-398.projects.os-home.net/',
        verifiedAt: '2026-07-28T08:00:00Z'
      }
    ]);
    const credentialUrl = snapshot([
      {
        headSha: identity.headSha,
        kind: 'full-preview',
        state: 'available',
        url: 'https://secret@example.com/',
        verifiedAt: '2026-07-28T08:00:00Z'
      }
    ]);
    const wrongIdentity = {
      ...snapshot([]),
      identity: { ...identity, pullRequestNumber: 399 }
    };
    const unsafeUrls = [
      'https://pr-399.projects.os-home.net/',
      'https://projects.os-home.net/',
      'https://pr-398.projects.os-home.net/?token=value',
      'https://pr-398.projects.os-home.net/#private',
      'https://pr-398.projects.os-home.net/prototype/mobile/'
    ].map((url) =>
      snapshot([
        {
          headSha: identity.headSha,
          kind: 'full-preview',
          state: 'available',
          url,
          verifiedAt: '2026-07-28T08:00:00Z'
        }
      ])
    );

    for (const candidate of [
      wrongHead,
      credentialUrl,
      wrongIdentity,
      ...unsafeUrls
    ]) {
      const targets = pullRequestChangelogTestTargetPresentation(
        identity,
        candidate
      );
      expect(targets.every((target) => target.state === 'unavailable')).toBe(
        true
      );
    }
  });

  test('rejects hidden URL fields in unavailable records and duplicate kinds', () => {
    const unsafeUnavailable = snapshot([
      {
        kind: 'full-preview',
        reasonCode: 'not-deployed',
        state: 'unavailable',
        url: 'https://pr-398.projects.os-home.net/'
      } as never
    ]);
    const duplicateKinds = snapshot([
      {
        kind: 'desktop-prototype',
        reasonCode: 'not-deployed',
        state: 'unavailable'
      },
      {
        kind: 'desktop-prototype',
        reasonCode: 'verification-unavailable',
        state: 'unavailable'
      }
    ]);
    const liveContext = snapshot([
      {
        feedback: { state: 'eligible' },
        headSha: identity.headSha,
        kind: 'full-preview',
        machineId: 'machine-secret',
        state: 'available',
        threadId: 'thread-secret',
        url: 'https://pr-398.projects.os-home.net/',
        verifiedAt: '2026-07-28T08:00:00Z'
      } as never
    ]);

    for (const candidate of [
      unsafeUnavailable,
      duplicateKinds,
      liveContext
    ]) {
      const targets = pullRequestChangelogTestTargetPresentation(
        identity,
        candidate
      );
      expect(targets.every((target) => target.state === 'unavailable')).toBe(
        true
      );
      expect(targets[0]).toMatchObject({
        kind: 'full-preview',
        state: 'unavailable'
      });
    }
  });
});
