import entriesSource from '@/content/docs/changelog/entries.json';
import versionsSource from '@/content/docs/changelog/versions.json';
import { parseChangelogCatalog } from './model';
import { readPrChangelogFiles, withPrChangelogEntries } from './pr-source';
import { withReleaseChangelogEntries } from './release-catalog';
import { previewTestsForCurrentBuild } from '../releases/preview-server';
import { releaseCatalogResult } from '../releases/source';

export function changelogCatalogForCurrentBuild() {
  const withLegacyReleases = withReleaseChangelogEntries(
    parseChangelogCatalog(entriesSource, versionsSource),
    releaseCatalogResult,
    previewTestsForCurrentBuild,
  );
  return withPrChangelogEntries(withLegacyReleases, readPrChangelogFiles());
}
