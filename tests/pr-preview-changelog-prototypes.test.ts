import { describe, expect, test } from 'bun:test';

import {
  pullRequestChangelogDocsHref,
  pullRequestChangelogSchema,
  type PullRequestChangelogEntry,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogSnapshot
} from '../src/shared/pr-preview-changelog-api';
import {
  pullRequestChangelogPrototypeSelection,
  pullRequestPrototypeReviewHref
} from '../src/shared/pr-preview-changelog-prototypes';

const identity: PullRequestChangelogIdentity = {
  headSha: 'a'.repeat(40),
  pullRequestNumber: 394,
  repositoryFullName: 'DotNaos/project-space'
};

function change(
  id: string,
  scenarioId: string,
  surface: 'desktop-prototype' | 'mobile-prototype'
): PullRequestChangelogEntry {
  return {
    category: 'changed',
    description: `Summary for ${id}.`,
    id,
    prototype: {
      scenarioId,
      surface,
      viewport:
        surface === 'mobile-prototype' ? 'phone' : 'desktop'
    },
    pullRequestNumber: identity.pullRequestNumber,
    summary: `Change ${id}`,
    testing: [`Test ${id}.`]
  };
}

function snapshot(
  entries: readonly PullRequestChangelogEntry[]
): PullRequestChangelogSnapshot {
  return {
    ...identity,
    docsHref: pullRequestChangelogDocsHref(
      identity.pullRequestNumber
    ),
    entries,
    schema: pullRequestChangelogSchema,
    state: 'available'
  };
}

describe('pull request changelog prototype discovery', () => {
  test('opens the one obvious Change without exposing its scenario', () => {
    const entry = change(
      'single-change',
      'ready',
      'desktop-prototype'
    );
    const selection = pullRequestChangelogPrototypeSelection(
      snapshot([entry]),
      identity,
      entry.id
    );
    const href = pullRequestPrototypeReviewHref(identity, entry);

    expect(selection).toEqual({ entry, state: 'ready' });
    expect(href).toContain('change=single-change');
    expect(href).toContain('surface=web');
    expect(href).toContain(`head=${identity.headSha}`);
    expect(href).not.toContain('scenario');
  });

  test('resolves every Change in a multi-prototype PR independently', () => {
    const desktop = change(
      'desktop-change',
      'long-content',
      'desktop-prototype'
    );
    const mobile = change(
      'mobile-change',
      'mobile-workflow',
      'mobile-prototype'
    );
    const source = snapshot([desktop, mobile]);

    expect(
      pullRequestChangelogPrototypeSelection(
        source,
        identity,
        desktop.id
      )
    ).toEqual({ entry: desktop, state: 'ready' });
    expect(
      pullRequestChangelogPrototypeSelection(
        source,
        identity,
        mobile.id
      )
    ).toEqual({ entry: mobile, state: 'ready' });
    expect(pullRequestPrototypeReviewHref(identity, mobile)).toContain(
      'surface=native'
    );
  });

  test('opens the first testable Change by default and rejects an unknown Change', () => {
    const known = change('known-change', 'ready', 'desktop-prototype');
    const source = snapshot([known]);

    expect(
      pullRequestChangelogPrototypeSelection(
        source,
        identity,
        undefined
      )
    ).toEqual({ entry: known, state: 'ready' });
    expect(
      pullRequestChangelogPrototypeSelection(
        source,
        identity,
        'unknown-change'
      )
    ).toMatchObject({ state: 'unknown' });
  });

  test('withholds Changes from a contradictory head revision', () => {
    const entry = change(
      'known-change',
      'ready',
      'desktop-prototype'
    );
    expect(
      pullRequestChangelogPrototypeSelection(
        snapshot([entry]),
        { ...identity, headSha: 'b'.repeat(40) },
        entry.id
      )
    ).toMatchObject({ state: 'unavailable' });
  });
});
