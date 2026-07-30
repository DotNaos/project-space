import entriesSource from '@/content/docs/changelog/entries.json';
import versionsSource from '@/content/docs/changelog/versions.json';
import { parseChangelogCatalog } from './model';
import { withReleaseChangelogEntries } from './release-catalog';
import { previewTestsForCurrentBuild } from '../releases/preview-server';
import { releaseCatalogResult } from '../releases/source';

export function changelogCatalogForCurrentBuild() {
  return withReleaseChangelogEntries(
    parseChangelogCatalog(entriesSource, versionsSource),
    releaseCatalogResult,
    previewTestsForCurrentBuild,
  );
}
