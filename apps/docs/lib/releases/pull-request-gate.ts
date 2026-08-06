import { compareStableSemver, expectedVersionForBump } from './semver';
import { parseReleaseCatalog } from './catalog';
import { parseReleaseEntryMdx } from './mdx';
import type { ReleaseEntry } from './types';

export interface ChangedReleaseFile {
  path: string;
  source?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
}

export interface ReleasePullRequestGateInput {
  changedReleaseFiles: ChangedReleaseFile[];
  currentMainVersion: string;
  existingGithubReleaseTags: ReadonlySet<string>;
  existingGitTags: ReadonlySet<string>;
  headEntries: ReadonlyMap<string, string>;
  headPackageVersion: string;
  mainEntries: ReadonlyMap<string, string>;
  pullRequestNumber: number;
}

export type ReleasePullRequestGateResult =
  | { mode: 'ordinary'; ok: true }
  | { entry: ReleaseEntry; mode: 'release'; ok: true }
  | { errors: string[]; ok: false };

const releaseDirectory =
  'apps/docs/content/docs/releases/entries/';

export function validateReleasePullRequest(
  input: ReleasePullRequestGateInput,
): ReleasePullRequestGateResult {
  const errors: string[] = [];
  const changed = input.changedReleaseFiles.filter(
    (file) =>
      file.path.startsWith(releaseDirectory) &&
      file.path.endsWith('.mdx'),
  );

  if (
    changed.length === 0 &&
    input.headPackageVersion === input.currentMainVersion
  ) {
    return { mode: 'ordinary', ok: true };
  }

  if (changed.length !== 1) {
    errors.push(changed.length === 0
      ? `Pull request #${input.pullRequestNumber} changes package.json from ${input.currentMainVersion} to ${input.headPackageVersion} without one release MDX file under ${releaseDirectory}.`
      : `Pull request #${input.pullRequestNumber} must add exactly one release MDX file under ${releaseDirectory}; found ${changed.length}.`);
    return { errors, ok: false };
  }

  const owned = changed[0];
  const expectedPath = `${releaseDirectory}${input.pullRequestNumber}.mdx`;
  if (owned.path !== expectedPath) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must own ${expectedPath}, not ${owned.path}.`,
    );
  }
  if (owned.status !== 'added') {
    errors.push(
      `${expectedPath} must be a newly added PR-owned release entry; status was ${owned.status}.`,
    );
  }
  if (!owned.source?.trim()) {
    errors.push(`${expectedPath} is missing or empty.`);
    return { errors: unique(errors), ok: false };
  }

  const parsed = parseReleaseEntryMdx(
    owned.source,
    `${input.pullRequestNumber}.mdx`,
  );
  if (!parsed.ok) {
    errors.push(...parsed.errors);
    return { errors: unique(errors), ok: false };
  }
  const entry = parsed.entry;

  const mainCatalog = parseReleaseCatalog(input.mainEntries);
  if (!mainCatalog.ok) {
    errors.push(
      ...mainCatalog.errors.map(
        (error) => `Latest main release catalog is invalid: ${error}`,
      ),
    );
  }
  const headCatalog = parseReleaseCatalog(input.headEntries);
  if (!headCatalog.ok) {
    errors.push(...headCatalog.errors);
  }

  if (entry.pullRequest !== input.pullRequestNumber) {
    errors.push(
      `Release pullRequest ${entry.pullRequest} does not match actual pull request #${input.pullRequestNumber}.`,
    );
  }
  if (entry.version !== input.headPackageVersion) {
    errors.push(
      `Release version ${entry.version} must match package.json version ${input.headPackageVersion}.`,
    );
  }

  let expectedVersion: string | undefined;
  try {
    expectedVersion = expectedVersionForBump(
      input.currentMainVersion,
      entry.bump,
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (expectedVersion && entry.version !== expectedVersion) {
    errors.push(
      `A ${entry.bump} bump from latest main ${input.currentMainVersion} must use version ${expectedVersion}, not ${entry.version}.`,
    );
  }
  try {
    if (
      compareStableSemver(
        entry.version,
        input.currentMainVersion,
      ) <= 0
    ) {
      errors.push(
        `Release version ${entry.version} must be greater than latest main ${input.currentMainVersion}.`,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (mainCatalog.ok && mainCatalog.catalog.versions.has(entry.version)) {
    errors.push(
      `Release version ${entry.version} is already owned by a release entry on latest main.`,
    );
  }
  if (input.existingGitTags.has(`v${entry.version}`)) {
    errors.push(
      `Git tag v${entry.version} already exists; advance the release version.`,
    );
  }
  if (input.existingGithubReleaseTags.has(`v${entry.version}`)) {
    errors.push(
      `GitHub Release v${entry.version} already exists; advance the release version.`,
    );
  }

  return errors.length > 0
    ? { errors: unique(errors), ok: false }
    : { entry, mode: 'release', ok: true };
}

function unique(values: string[]) {
  return [...new Set(values)];
}
