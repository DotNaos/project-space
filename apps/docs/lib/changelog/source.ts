import entriesSource from '@/content/docs/changelog/entries.json';
import versionsSource from '@/content/docs/changelog/versions.json';
import { parseChangelogCatalog } from './model';

export const changelogCatalogResult = parseChangelogCatalog(
  entriesSource,
  versionsSource,
);
