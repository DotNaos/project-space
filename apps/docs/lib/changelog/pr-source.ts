import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePrChangelog } from './pr-file';
import type { ChangelogCatalogResult, ChangelogEntry } from './model';

export function readPrChangelogFiles(
  directory = repositoryChangelogDirectory(),
): Map<string, string> {
  const files = new Map<string, string>();
  try {
    for (const fileName of readdirSync(directory).filter((name) => name.endsWith('.md')).sort()) {
      files.set(fileName, readFileSync(join(directory, fileName), 'utf8'));
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return files;
    throw error;
  }
  return files;
}

function repositoryChangelogDirectory() {
  const fromCurrentDirectory = resolve(process.cwd(), 'changelog');
  if (hasDirectory(fromCurrentDirectory)) return fromCurrentDirectory;
  return resolve(process.cwd(), '..', '..', 'changelog');
}

function hasDirectory(directory: string) {
  return existsSync(directory);
}

export function withPrChangelogEntries(
  base: ChangelogCatalogResult,
  files: Map<string, string>,
): ChangelogCatalogResult {
  if (!base.ok) return base;
  const errors: string[] = [];
  const entries: ChangelogEntry[] = [];
  const ids = new Set(base.catalog.entries.map((entry) => entry.id));
  const pullRequests = new Set(
    base.catalog.entries.map((entry) => entry.pullRequestNumber),
  );

  for (const [fileName, source] of files) {
    const parsed = parsePrChangelog(source, fileName);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    const id = `pr-${parsed.changelog.pullRequest}-changelog`;
    if (ids.has(id)) {
      errors.push(`Raw changelog ${fileName} duplicates entry id "${id}".`);
      continue;
    }
    if (pullRequests.has(parsed.changelog.pullRequest)) {
      errors.push(
        `Raw changelog ${fileName} duplicates an existing PR #${parsed.changelog.pullRequest} entry.`,
      );
      continue;
    }
    ids.add(id);
    pullRequests.add(parsed.changelog.pullRequest);
    entries.push({
      body: parsed.changelog.body,
      category: 'changed',
      id,
      pullRequestNumber: parsed.changelog.pullRequest,
      summary: parsed.changelog.summary,
      testing: [],
    });
  }

  if (errors.length > 0) return { errors: unique(errors), ok: false };
  return {
    catalog: {
      entries: [...base.catalog.entries, ...entries],
      versions: base.catalog.versions,
    },
    ok: true,
  };
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
