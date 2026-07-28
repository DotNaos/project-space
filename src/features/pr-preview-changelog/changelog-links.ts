import entriesSource from '../../../apps/docs/content/docs/changelog/entries.json';
import changelogSchema from '../../../apps/docs/content/docs/changelog/schema.json';
import versionsSource from '../../../apps/docs/content/docs/changelog/versions.json';

const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
const entryId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semanticVersionPattern = new RegExp(
  changelogSchema.semanticVersionPattern
);
const categories = new Set([
  'added',
  'changed',
  'fixed',
  'deprecated',
  'removed',
  'security'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isStringList(value: unknown) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString)
  );
}

function canonicalEntryIds(source: unknown) {
  if (
    !isRecord(source) ||
    source.schema !== 'project-space.changelog/v1' ||
    !Array.isArray(source.entries)
  ) {
    return undefined;
  }

  const ids = new Set<string>();
  for (const candidate of source.entries) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.id) ||
      !entryId.test(candidate.id) ||
      ids.has(candidate.id) ||
      !isNonEmptyString(candidate.category) ||
      !categories.has(candidate.category) ||
      !isNonEmptyString(candidate.summary) ||
      !isNonEmptyString(candidate.body) ||
      !isPositiveInteger(candidate.pullRequestNumber) ||
      (candidate.issueNumber !== undefined &&
        !isPositiveInteger(candidate.issueNumber)) ||
      !isStringList(candidate.testing)
    ) {
      return undefined;
    }
    ids.add(candidate.id);
  }
  return ids;
}

function isRealCalendarDate(value: string) {
  if (!calendarDate.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function canonicalPublishedVersions(
  entries: unknown,
  source: unknown
) {
  const ids = canonicalEntryIds(entries);
  if (
    !ids ||
    !isRecord(source) ||
    source.schema !== 'project-space.changelog-versions/v1' ||
    !Array.isArray(source.versions)
  ) {
    return undefined;
  }

  const versions = new Set<string>();
  const assignedEntries = new Set<string>();
  for (const candidate of source.versions) {
    if (
      !isRecord(candidate) ||
      !isNonEmptyString(candidate.version) ||
      !semanticVersionPattern.test(candidate.version) ||
      versions.has(candidate.version) ||
      !isNonEmptyString(candidate.releasedAt) ||
      !isRealCalendarDate(candidate.releasedAt) ||
      !Array.isArray(candidate.entryIds) ||
      candidate.entryIds.length === 0 ||
      !candidate.entryIds.every(isNonEmptyString) ||
      new Set(candidate.entryIds).size !== candidate.entryIds.length ||
      candidate.entryIds.some(
        (id) => !ids.has(id) || assignedEntries.has(id)
      )
    ) {
      return undefined;
    }
    versions.add(candidate.version);
    candidate.entryIds.forEach((id) => assignedEntries.add(id));
  }
  return versions;
}

export function releasedChangelogHrefFromSources(
  version: string,
  entries: unknown,
  versions: unknown
) {
  const normalized = version.trim();
  if (!semanticVersionPattern.test(normalized)) return undefined;

  const publishedVersions = canonicalPublishedVersions(entries, versions);
  if (!publishedVersions?.has(normalized)) {
    return undefined;
  }

  return `/docs/changelog?version=${encodeURIComponent(normalized)}`;
}

export function releasedChangelogHref(version: string) {
  return releasedChangelogHrefFromSources(
    version,
    entriesSource,
    versionsSource
  );
}
