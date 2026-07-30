import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readReleaseCatalog } from './catalog';

export function releaseEntriesDirectory() {
  const direct = join(
    process.cwd(),
    'content/docs/releases/entries',
  );
  if (existsSync(direct)) return direct;
  return join(
    process.cwd(),
    'apps/docs/content/docs/releases/entries',
  );
}

export const releaseCatalogResult = readReleaseCatalog(
  releaseEntriesDirectory(),
);
