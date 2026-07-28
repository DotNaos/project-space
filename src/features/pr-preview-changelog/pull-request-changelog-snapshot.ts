import changelogSource from '../../../apps/docs/content/docs/changelog/entries.json';

import {
  isPullRequestChangelogIdentity,
  pullRequestChangelogCategories,
  pullRequestChangelogDocsHref,
  pullRequestChangelogSchema,
  type PullRequestChangelogCategory,
  type PullRequestChangelogEntry,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogSnapshot
} from '@/shared/pr-preview-changelog-api';

const changelogSourceSchema = 'project-space.changelog/v1';
const entryId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface ChangelogSourceEntry extends PullRequestChangelogEntry {
  body: string;
}

interface ChangelogSource {
  entries: readonly ChangelogSourceEntry[];
  schema: typeof changelogSourceSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCategory(
  value: unknown
): value is PullRequestChangelogCategory {
  return (
    typeof value === 'string' &&
    pullRequestChangelogCategories.some((category) => category === value)
  );
}

function parseEntry(value: unknown): ChangelogSourceEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (!isNonEmptyString(value.id) || !entryId.test(value.id)) {
    return undefined;
  }
  if (!isCategory(value.category)) return undefined;
  if (!isNonEmptyString(value.summary)) return undefined;
  if (!isNonEmptyString(value.body)) return undefined;
  if (!isPositiveInteger(value.pullRequestNumber)) return undefined;
  if (
    value.issueNumber !== undefined &&
    !isPositiveInteger(value.issueNumber)
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.testing) ||
    value.testing.length === 0 ||
    !value.testing.every(isNonEmptyString)
  ) {
    return undefined;
  }

  return {
    body: value.body.trim(),
    category: value.category,
    id: value.id,
    ...(value.issueNumber === undefined
      ? {}
      : { issueNumber: value.issueNumber }),
    pullRequestNumber: value.pullRequestNumber,
    summary: value.summary.trim(),
    testing: value.testing.map((step) => step.trim())
  };
}

function parseSource(value: unknown): ChangelogSource | undefined {
  if (!isRecord(value) || value.schema !== changelogSourceSchema) {
    return undefined;
  }
  if (!Array.isArray(value.entries)) return undefined;

  const entries = value.entries.map(parseEntry);
  if (entries.some((entry) => entry === undefined)) return undefined;

  const parsedEntries = entries as ChangelogSourceEntry[];
  const ids = new Set(parsedEntries.map((entry) => entry.id));
  if (ids.size !== parsedEntries.length) return undefined;

  return {
    entries: parsedEntries,
    schema: changelogSourceSchema
  };
}

function invalidSnapshot(
  identity: PullRequestChangelogIdentity
): PullRequestChangelogSnapshot {
  return {
    ...identity,
    entries: [],
    reasonCode: 'invalid-metadata',
    schema: pullRequestChangelogSchema,
    state: 'invalid'
  };
}

export function pullRequestChangelogSnapshotFromSource(
  identity: PullRequestChangelogIdentity,
  source: unknown
): PullRequestChangelogSnapshot {
  if (!isPullRequestChangelogIdentity(identity)) {
    return invalidSnapshot(identity);
  }

  const parsedSource = parseSource(source);
  if (!parsedSource) return invalidSnapshot(identity);

  const entries = parsedSource.entries
    .filter(
      (entry) =>
        entry.pullRequestNumber === identity.pullRequestNumber
    )
    .map(
      ({
        category,
        id,
        issueNumber,
        pullRequestNumber,
        summary,
        testing
      }): PullRequestChangelogEntry => ({
        category,
        id,
        ...(issueNumber === undefined ? {} : { issueNumber }),
        pullRequestNumber,
        summary,
        testing
      })
    );
  const docsHref = pullRequestChangelogDocsHref(
    identity.pullRequestNumber
  );

  if (entries.length === 0) {
    return {
      ...identity,
      docsHref,
      entries: [],
      reasonCode: 'no-entry',
      schema: pullRequestChangelogSchema,
      state: 'missing'
    };
  }

  return {
    ...identity,
    docsHref,
    entries,
    schema: pullRequestChangelogSchema,
    state: 'available'
  };
}

export function pullRequestChangelogSnapshotFor(
  identity: PullRequestChangelogIdentity
): PullRequestChangelogSnapshot {
  return pullRequestChangelogSnapshotFromSource(
    identity,
    changelogSource
  );
}
