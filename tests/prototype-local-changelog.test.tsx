import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';
import { PrototypeReleaseEntryContent } from '../apps/prototype/src/prototype-release-entry-content';
import { PrototypeWipReview } from '../apps/prototype/src/prototype-wip-review';
import {
  prototypeReviewChecklist,
  type PrototypeReviewLocalChangelogSnapshot
} from '../src/shared/prototype-review-local-changelog-api';

describe('local prototype changelog', () => {
  test('migrates the legacy five-state review to the single current prototype', () => {
    expect(prototypeReviewChecklist([
      { id: 'ready', label: 'Default', reviewed: true },
      { id: 'empty', label: 'Empty', reviewed: false },
      { id: 'offline', label: 'Offline', reviewed: false },
      { id: 'long-content', label: 'Long content', reviewed: false },
      { id: 'branch-head-preview', label: 'Branch head preview', reviewed: false }
    ])).toEqual([
      { id: 'ready', label: 'Current prototype', reviewed: true }
    ]);
  });

  test('renders the canonical release MDX structure instead of Preview scenarios', () => {
    const path = 'apps/docs/content/docs/releases/entries/435.mdx';
    const parsed = parseReleaseEntryMdx(readFileSync(path, 'utf8'), '435.mdx');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const html = renderToStaticMarkup(
      <PrototypeReleaseEntryContent entry={{
        areas: parsed.entry.areas,
        breakingChanges: parsed.entry.breakingChanges,
        changes: parsed.entry.changes,
        issues: parsed.entry.issues,
        path,
        previewTests: parsed.entry.previewTests,
        pullRequest: parsed.entry.pullRequest,
        summary: parsed.entry.summary,
        title: parsed.entry.title,
        upgrade: parsed.entry.upgrade,
        upgradeNotes: parsed.entry.upgradeNotes,
        version: parsed.entry.version
      }} />
    );

    expect(html).toContain('Make pull request revisions green on first push');
    expect(html).toContain('v0.4.56');
    expect(html).toContain('Changes');
    expect(html).toContain('What to test');
    expect(html).toContain('Source: apps/docs/content/docs/releases/entries/435.mdx');
    expect(html).not.toContain('The populated default state of the current interface.');
  });

  test('renders one review checkbox for the current prototype without comment controls', () => {
    const snapshot: PrototypeReviewLocalChangelogSnapshot = {
      branchName: 'issue-437-redesign-the-project-space-frontend',
      checkedAt: '2026-07-31T12:00:00.000Z',
      entry: { reason: 'no-pull-request', state: 'missing' },
      headSha: 'a'.repeat(40),
      repositoryFullName: 'DotNaos/project-space',
      review: {
        items: [{ id: 'ready', label: 'Current prototype', reviewed: false }],
        storagePath: '.project-space/prototype-review/test.json',
        writable: true
      },
      schema: 'project-space.prototype-review-local-changelog/v2'
    };
    const html = renderToStaticMarkup(
      <PrototypeWipReview
        saving={false}
        snapshot={snapshot}
        onSave={async () => undefined}
      />
    );

    expect(html.match(/type="checkbox"/g)).toHaveLength(1);
    expect(html).toContain('Current prototype');
    expect(html).not.toContain('Branch head preview');
    expect(html).not.toContain('What should we verify or improve?');
    expect(html).not.toContain('WIP note');
    expect(html).not.toContain('Saved by the local dev server');
  });
});
