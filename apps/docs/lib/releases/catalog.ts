import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareStableSemver } from './semver';
import { parseReleaseEntryMdx } from './mdx';
import type {
  ReleaseCatalog,
  ReleaseEntry,
  ReleaseEntryParseFailure,
} from './types';

export type ReleaseCatalogResult =
  | { catalog: ReleaseCatalog; ok: true }
  | ReleaseEntryParseFailure;

export function parseReleaseCatalog(
  files: ReadonlyMap<string, string>,
): ReleaseCatalogResult {
  const entries: ReleaseEntry[] = [];
  const errors: string[] = [];
  const versions = new Map<string, ReleaseEntry>();
  const pullRequests = new Map<number, ReleaseEntry>();

  for (const [fileName, source] of files) {
    const result = parseReleaseEntryMdx(source, fileName);
    if (!result.ok) {
      errors.push(
        ...result.errors.map((error) => `${fileName}: ${error}`),
      );
      continue;
    }

    const duplicateVersion = versions.get(result.entry.version);
    if (duplicateVersion) {
      errors.push(
        `${fileName}: version ${result.entry.version} is already owned by ${duplicateVersion.fileName}.`,
      );
    } else {
      versions.set(result.entry.version, result.entry);
    }

    const duplicatePullRequest = pullRequests.get(
      result.entry.pullRequest,
    );
    if (duplicatePullRequest) {
      errors.push(
        `${fileName}: pull request #${result.entry.pullRequest} is already documented by ${duplicatePullRequest.fileName}.`,
      );
    } else {
      pullRequests.set(result.entry.pullRequest, result.entry);
    }
    entries.push(result.entry);
  }

  if (errors.length > 0) {
    return { errors: [...new Set(errors)], ok: false };
  }

  entries.sort((left, right) =>
    compareStableSemver(right.version, left.version),
  );
  return { catalog: { entries, versions }, ok: true };
}

export function readReleaseCatalog(
  directory: string,
): ReleaseCatalogResult {
  const files = new Map<string, string>();
  for (const fileName of readdirSync(directory, {
    withFileTypes: true,
  })) {
    if (!fileName.isFile() || !fileName.name.endsWith('.mdx')) {
      continue;
    }
    files.set(
      fileName.name,
      readFileSync(join(directory, fileName.name), 'utf8'),
    );
  }
  return parseReleaseCatalog(files);
}
