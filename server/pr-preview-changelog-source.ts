import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const changelogSchema = 'project-space.changelog/v1';
const categories = new Set([
  'added',
  'changed',
  'deprecated',
  'fixed',
  'removed',
  'security'
]);
const entryId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const scenarioId = entryId;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPrototype(value: unknown) {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    isNonEmptyString(value.scenarioId) &&
    scenarioId.test(value.scenarioId) &&
    (value.surface === 'desktop-prototype' ||
      value.surface === 'mobile-prototype') &&
    (value.viewport === 'phone' ||
      value.viewport === 'tablet' ||
      value.viewport === 'desktop')
  );
}

function isChangelogEntry(value: unknown) {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    entryId.test(value.id) &&
    typeof value.category === 'string' &&
    categories.has(value.category) &&
    isNonEmptyString(value.summary) &&
    isNonEmptyString(value.body) &&
    isPositiveInteger(value.pullRequestNumber) &&
    (value.issueNumber === undefined || isPositiveInteger(value.issueNumber)) &&
    (value.prototype === undefined || isPrototype(value.prototype)) &&
    Array.isArray(value.testing) &&
    value.testing.length > 0 &&
    value.testing.every(isNonEmptyString)
  );
}

export function readExactPullRequestChangelogSource(
  repositoryRoot: string,
  pullRequestNumber: number
) {
  try {
    const source = JSON.parse(
      readFileSync(
        resolve(
          repositoryRoot,
          'apps/docs/content/docs/changelog/entries.json'
        ),
        'utf8'
      )
    ) as unknown;
    if (
      !isRecord(source) ||
      source.schema !== changelogSchema ||
      !Array.isArray(source.entries)
    ) {
      return undefined;
    }
    const entries = source.entries.filter(
      (entry) =>
        isRecord(entry) &&
        entry.pullRequestNumber === pullRequestNumber
    );
    if (!entries.every(isChangelogEntry)) return undefined;
    const ids = new Set(entries.map((entry) => entry.id));
    if (ids.size !== entries.length) return undefined;
    return {
      entries,
      schema: changelogSchema
    };
  } catch {
    return undefined;
  }
}
