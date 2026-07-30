import type { ReleaseCatalogResult } from '../releases/catalog';
import { generatedReleaseChangelogSource } from '../releases/changelog-source';
import type { ReleaseEntry } from '../releases/types';
import type {
  ChangelogCatalogResult,
  ChangelogEntry,
} from './model';

type TestingForEntry = (entry: ReleaseEntry) => string[] | undefined;

export function withReleaseChangelogEntries(
  base: ChangelogCatalogResult,
  releases: ReleaseCatalogResult,
  testingForEntry: TestingForEntry,
): ChangelogCatalogResult {
  if (!base.ok) return base;
  if (!releases.ok) return releases;

  const releaseByPullRequest = new Map(
    releases.catalog.entries.map((entry) => [
      entry.pullRequest,
      entry,
    ]),
  );
  const testingByPullRequest = new Map(
    releases.catalog.entries.map((entry) => [
      entry.pullRequest,
      testingForEntry(entry),
    ]),
  );
  const generated = generatedReleaseChangelogSource(
    releases.catalog.entries,
  );
  const generatedEntries: ChangelogEntry[] = generated.entries.map(
    (entry) => {
      const release = releaseByPullRequest.get(
        entry.pullRequestNumber,
      )!;
      const releaseTesting = testingByPullRequest.get(
        entry.pullRequestNumber,
      );
      return {
        ...entry,
        ...(releaseTesting
          ? { releaseTesting }
          : {}),
        releaseVersion: release.version,
        testing: [],
      };
    },
  );
  const errors = collisionErrors(
    base.catalog.entries,
    base.catalog.versions.map((version) => version.version),
    generatedEntries,
    releases.catalog.entries,
  );
  if (errors.length > 0) return { errors, ok: false };

  const existingEntries = base.catalog.entries.map((entry) => {
    const release = releaseByPullRequest.get(
      entry.pullRequestNumber,
    );
    if (!release) return entry;
    return {
      ...entry,
      releaseVersion: release.version,
      testing: testingByPullRequest.has(
        entry.pullRequestNumber,
      ) && testingByPullRequest.get(entry.pullRequestNumber)
        ? entry.testing
        : [],
    };
  });

  return {
    catalog: {
      entries: [
        ...generatedEntries,
        ...existingEntries,
      ],
      versions: base.catalog.versions,
    },
    ok: true,
  };
}

function collisionErrors(
  existingEntries: ChangelogEntry[],
  existingVersions: string[],
  generatedEntries: ChangelogEntry[],
  releases: ReleaseEntry[],
) {
  const errors: string[] = [];
  const entryIds = new Set(
    existingEntries.map((entry) => entry.id),
  );
  for (const entry of generatedEntries) {
    if (entryIds.has(entry.id)) {
      errors.push(
        `Release changelog entry "${entry.id}" duplicates an existing changelog entry.`,
      );
    }
    entryIds.add(entry.id);
  }

  const versions = new Set(existingVersions);
  for (const release of releases) {
    if (versions.has(release.version)) {
      errors.push(
        `Release version ${release.version} is already documented by the legacy changelog source.`,
      );
    }
    versions.add(release.version);
  }
  return errors;
}
