import {
  compareChangelogVersions,
  isChangelogVersion,
} from './semantic-version';

export const changelogCategories = [
  'added',
  'changed',
  'fixed',
  'deprecated',
  'removed',
  'security',
] as const;

export type ChangelogCategory = (typeof changelogCategories)[number];

export type ChangelogPrototypeSurface =
  | 'desktop-prototype'
  | 'mobile-prototype';

export type ChangelogPrototypeViewport =
  | 'phone'
  | 'tablet'
  | 'desktop';

export interface ChangelogPrototype {
  scenarioId: string;
  surface: ChangelogPrototypeSurface;
  viewport: ChangelogPrototypeViewport;
}

export interface ChangelogEntry {
  id: string;
  category: ChangelogCategory;
  summary: string;
  body: string;
  issueNumber?: number;
  prototype?: ChangelogPrototype;
  pullRequestNumber: number;
  testing: string[];
}

export interface ChangelogVersion {
  version: string;
  releasedAt: string;
  entryIds: string[];
}

export interface ChangelogCatalog {
  entries: ChangelogEntry[];
  versions: ChangelogVersion[];
}

export interface ChangelogGroup {
  key: string;
  label: string;
  releasedAt?: string;
  entries: ChangelogEntry[];
}

export interface ChangelogFilters {
  pullRequestNumber?: number;
  version?: string;
}

export type ChangelogCatalogResult =
  | { ok: true; catalog: ChangelogCatalog }
  | { ok: false; errors: string[] };

export type ChangelogFilterResult =
  | { ok: true; filters: ChangelogFilters }
  | { ok: false; message: string };

export type ChangelogView =
  | {
      state: 'ready';
      filters: ChangelogFilters;
      groups: ChangelogGroup[];
      highlightedPullRequest?: number;
    }
  | {
      state: 'not-found' | 'contradictory';
      filters: ChangelogFilters;
      message: string;
    };

type SearchValue = string | string[] | undefined;

const entrySchema = 'project-space.changelog/v1';
const versionsSchema = 'project-space.changelog-versions/v1';
const entryIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const scenarioIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const categories = new Set<string>(changelogCategories);

export function parseChangelogCatalog(
  entriesSource: unknown,
  versionsSource: unknown,
): ChangelogCatalogResult {
  const errors: string[] = [];
  const entries = parseEntries(entriesSource, errors);
  const versions = parseVersions(versionsSource, errors);

  if (entries && versions) {
    validateReferences(entries, versions, errors);
  }

  if (errors.length > 0 || !entries || !versions) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    catalog: { entries, versions: sortVersions(versions) },
  };
}

export function parseChangelogFilters(
  searchParams: Record<string, SearchValue>,
): ChangelogFilterResult {
  const prValue = singleValue(searchParams.pr);
  const versionValue = singleValue(searchParams.version);

  if (prValue.state === 'duplicate' || versionValue.state === 'duplicate') {
    return {
      ok: false,
      message: 'Each changelog filter may be provided only once.',
    };
  }

  const filters: ChangelogFilters = {};
  if (prValue.state === 'value') {
    if (!/^[1-9]\d*$/.test(prValue.value)) {
      return {
        ok: false,
        message: 'Pull request filters must be positive GitHub pull request numbers.',
      };
    }
    const parsed = Number(prValue.value);
    if (!Number.isSafeInteger(parsed)) {
      return {
        ok: false,
        message: 'The pull request number is too large to use safely.',
      };
    }
    filters.pullRequestNumber = parsed;
  }

  if (versionValue.state === 'value') {
    if (!isChangelogVersion(versionValue.value)) {
      return {
        ok: false,
        message: 'Version filters must use a published version such as 0.4.36.',
      };
    }
    filters.version = versionValue.value;
  }

  return { ok: true, filters };
}

export function buildChangelogView(
  catalog: ChangelogCatalog,
  filters: ChangelogFilters,
): ChangelogView {
  const allGroups = buildGroups(catalog);
  const pullRequestNumber = filters.pullRequestNumber;
  const version = filters.version;

  if (version) {
    const versionGroup = allGroups.find((group) => group.key === version);
    if (!versionGroup) {
      return {
        state: 'not-found',
        filters,
        message: `Published version ${version} is not documented in this source revision.`,
      };
    }

    if (pullRequestNumber !== undefined) {
      const matchingEntry = versionGroup.entries.some(
        (entry) => entry.pullRequestNumber === pullRequestNumber,
      );
      if (!matchingEntry) {
        const documentedElsewhere = catalog.entries.some(
          (entry) => entry.pullRequestNumber === pullRequestNumber,
        );
        return {
          state: documentedElsewhere ? 'contradictory' : 'not-found',
          filters,
          message: documentedElsewhere
            ? `Pull request #${pullRequestNumber} is documented, but it is not part of version ${version}.`
            : `No changelog entry for pull request #${pullRequestNumber} is documented in this source revision.`,
        };
      }
    }

    return {
      state: 'ready',
      filters,
      groups: [versionGroup],
      highlightedPullRequest: pullRequestNumber,
    };
  }

  if (pullRequestNumber !== undefined) {
    const groups = allGroups
      .map((group) => ({
        ...group,
        entries: group.entries.filter(
          (entry) => entry.pullRequestNumber === pullRequestNumber,
        ),
      }))
      .filter((group) => group.entries.length > 0);

    if (groups.length === 0) {
      return {
        state: 'not-found',
        filters,
        message: `No changelog entry for pull request #${pullRequestNumber} is documented in this source revision.`,
      };
    }

    return {
      state: 'ready',
      filters,
      groups,
      highlightedPullRequest: pullRequestNumber,
    };
  }

  return { state: 'ready', filters, groups: allGroups };
}

function buildGroups(catalog: ChangelogCatalog): ChangelogGroup[] {
  const entryById = new Map(catalog.entries.map((entry) => [entry.id, entry]));
  const releasedIds = new Set(catalog.versions.flatMap((version) => version.entryIds));
  const unreleased = catalog.entries.filter((entry) => !releasedIds.has(entry.id));
  const groups: ChangelogGroup[] = [];

  if (unreleased.length > 0) {
    groups.push({
      key: 'unreleased',
      label: 'Unreleased',
      entries: unreleased,
    });
  }

  for (const release of catalog.versions) {
    groups.push({
      key: release.version,
      label: release.version,
      releasedAt: release.releasedAt,
      entries: release.entryIds.map((id) => entryById.get(id)!),
    });
  }

  return groups;
}

function parseEntries(source: unknown, errors: string[]): ChangelogEntry[] | undefined {
  if (
    !isRecord(source) ||
    source.schema !== entrySchema ||
    !Array.isArray(source.entries)
  ) {
    errors.push(`Changelog entries must use schema ${entrySchema}.`);
    return undefined;
  }

  const entries: ChangelogEntry[] = [];
  const seenIds = new Set<string>();
  source.entries.forEach((value, index) => {
    const path = `entries[${index}]`;
    if (!isRecord(value)) {
      errors.push(`${path} must be an object.`);
      return;
    }

    const id = requiredString(value.id, `${path}.id`, errors);
    const category = requiredString(value.category, `${path}.category`, errors);
    const summary = requiredString(value.summary, `${path}.summary`, errors);
    const body = requiredString(value.body, `${path}.body`, errors);
    const pullRequestNumber = positiveInteger(
      value.pullRequestNumber,
      `${path}.pullRequestNumber`,
      errors,
    );
    const issueNumber =
      value.issueNumber === undefined
        ? undefined
        : positiveInteger(value.issueNumber, `${path}.issueNumber`, errors);
    const testing = stringList(value.testing, `${path}.testing`, errors);
    const prototype =
      value.prototype === undefined
        ? undefined
        : parsePrototype(value.prototype, `${path}.prototype`, errors);

    if (id && !entryIdPattern.test(id)) {
      errors.push(`${path}.id must use lowercase words separated by hyphens.`);
    }
    if (id && seenIds.has(id)) {
      errors.push(`Changelog entry id "${id}" is duplicated.`);
    } else if (id) {
      seenIds.add(id);
    }
    if (category && !categories.has(category)) {
      errors.push(`${path}.category is not supported.`);
    }

    if (
      id &&
      entryIdPattern.test(id) &&
      category &&
      categories.has(category) &&
      summary &&
      body &&
      pullRequestNumber &&
      testing
    ) {
      entries.push({
        id,
        category: category as ChangelogCategory,
        summary: summary.trim(),
        body: body.trim(),
        pullRequestNumber,
        ...(issueNumber ? { issueNumber } : {}),
        ...(prototype ? { prototype } : {}),
        testing: testing.map((guidance) => guidance.trim()),
      });
    }
  });

  return entries;
}

function parsePrototype(
  value: unknown,
  path: string,
  errors: string[],
): ChangelogPrototype | undefined {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object.`);
    return undefined;
  }
  const scenarioId = requiredString(
    value.scenarioId,
    `${path}.scenarioId`,
    errors,
  );
  if (scenarioId && !scenarioIdPattern.test(scenarioId)) {
    errors.push(
      `${path}.scenarioId must use lowercase words separated by hyphens.`,
    );
  }
  if (
    value.surface !== 'desktop-prototype' &&
    value.surface !== 'mobile-prototype'
  ) {
    errors.push(
      `${path}.surface must be desktop-prototype or mobile-prototype.`,
    );
  }
  if (
    value.viewport !== 'phone' &&
    value.viewport !== 'tablet' &&
    value.viewport !== 'desktop'
  ) {
    errors.push(`${path}.viewport must be phone, tablet, or desktop.`);
  }
  if (
    Object.keys(value).length !== 3 ||
    !scenarioId ||
    !scenarioIdPattern.test(scenarioId) ||
    (value.surface !== 'desktop-prototype' &&
      value.surface !== 'mobile-prototype') ||
    (value.viewport !== 'phone' &&
      value.viewport !== 'tablet' &&
      value.viewport !== 'desktop')
  ) {
    return undefined;
  }
  return {
    scenarioId,
    surface: value.surface,
    viewport: value.viewport,
  };
}

function parseVersions(source: unknown, errors: string[]): ChangelogVersion[] | undefined {
  if (
    !isRecord(source) ||
    source.schema !== versionsSchema ||
    !Array.isArray(source.versions)
  ) {
    errors.push(`Published versions must use schema ${versionsSchema}.`);
    return undefined;
  }

  const versions: ChangelogVersion[] = [];
  const seenVersions = new Set<string>();
  source.versions.forEach((value, index) => {
    const path = `versions[${index}]`;
    if (!isRecord(value)) {
      errors.push(`${path} must be an object.`);
      return;
    }

    const version = requiredString(value.version, `${path}.version`, errors);
    const releasedAt = requiredString(value.releasedAt, `${path}.releasedAt`, errors);
    const entryIds = stringList(value.entryIds, `${path}.entryIds`, errors);

    if (version && !isChangelogVersion(version)) {
      errors.push(`${path}.version must be a semantic version without a leading v.`);
    }
    if (version && seenVersions.has(version)) {
      errors.push(`Published version "${version}" is duplicated.`);
    } else if (version) {
      seenVersions.add(version);
    }
    if (releasedAt && !isCalendarDate(releasedAt)) {
      errors.push(`${path}.releasedAt must be a real YYYY-MM-DD date.`);
    }
    if (entryIds && entryIds.length === 0) {
      errors.push(`${path}.entryIds must contain at least one changelog entry.`);
    }
    if (entryIds && new Set(entryIds).size !== entryIds.length) {
      errors.push(`${path}.entryIds contains a duplicate entry id.`);
    }

    if (
      version &&
      isChangelogVersion(version) &&
      releasedAt &&
      isCalendarDate(releasedAt) &&
      entryIds &&
      entryIds.length > 0
    ) {
      versions.push({ version, releasedAt, entryIds });
    }
  });

  return versions;
}

function validateReferences(
  entries: ChangelogEntry[],
  versions: ChangelogVersion[],
  errors: string[],
) {
  const ids = new Set(entries.map((entry) => entry.id));
  const assigned = new Map<string, string>();

  for (const release of versions) {
    for (const entryId of release.entryIds) {
      if (!ids.has(entryId)) {
        errors.push(`Version ${release.version} references unknown entry "${entryId}".`);
      }
      const previousVersion = assigned.get(entryId);
      if (previousVersion) {
        errors.push(
          `Entry "${entryId}" is assigned to both ${previousVersion} and ${release.version}.`,
        );
      } else {
        assigned.set(entryId, release.version);
      }
    }
  }
}

function sortVersions(versions: ChangelogVersion[]) {
  return [...versions].sort(
    (left, right) =>
      right.releasedAt.localeCompare(left.releasedAt) ||
      compareChangelogVersions(right.version, left.version),
  );
}

function requiredString(value: unknown, path: string, errors: string[]) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path} must be a non-empty string.`);
    return undefined;
  }
  return value;
}

function positiveInteger(value: unknown, path: string, errors: string[]) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    errors.push(`${path} must be a positive integer.`);
    return undefined;
  }
  return value as number;
}

function stringList(value: unknown, path: string, errors: string[]) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    errors.push(`${path} must contain at least one non-empty string.`);
    return undefined;
  }
  return value as string[];
}

function singleValue(value: SearchValue) {
  if (Array.isArray(value)) return { state: 'duplicate' as const };
  if (value === undefined || value === '') return { state: 'empty' as const };
  return { state: 'value' as const, value };
}

function isCalendarDate(value: string) {
  if (!datePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
