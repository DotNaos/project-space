import {
  isPrChangelogFileName,
  parsePrChangelog,
  prChangelogDirectory,
  type PrChangelog,
} from '../changelog/pr-file';
import { releaseIntentDirectory } from './release-intent';
import type { ReleaseBump } from './types';

export interface ChangedReleaseFile {
  path: string;
  source?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
}

export interface ReleasePullRequestGateInput {
  basePackageVersion: string;
  changedFiles: ChangedReleaseFile[];
  headPackageVersion: string;
  pullRequestNumber: number;
}

export type ReleasePullRequestGateResult =
  | { bump: ReleaseBump; changelog: PrChangelog; ok: true }
  | { errors: string[]; ok: false };

const releaseEntryDirectory =
  'apps/docs/content/docs/releases/entries/';

export function validateReleasePullRequest(
  input: ReleasePullRequestGateInput,
): ReleasePullRequestGateResult {
  const errors: string[] = [];
  if (input.headPackageVersion !== input.basePackageVersion) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must not change package.json version ${input.basePackageVersion}; concrete release versions are assigned after merge.`,
    );
  }

  const changedEntries = input.changedFiles.filter((file) =>
    file.path.startsWith(releaseEntryDirectory) && file.path.endsWith('.mdx'),
  );
  if (changedEntries.length > 0) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must not change historical release entries: ${changedEntries.map(({ path }) => path).join(', ')}.`,
    );
  }

  const changedLegacyIntents = input.changedFiles.filter((file) =>
    file.path.startsWith(`${releaseIntentDirectory}/`),
  );
  if (changedLegacyIntents.length > 0) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must use changelog/<PR>.md; legacy release-intents are historical compatibility data and may not be added or changed.`,
    );
  }

  const changelogPaths = input.changedFiles.filter((file) =>
    file.path.startsWith(`${prChangelogDirectory}/`),
  );
  if (changelogPaths.length !== 1) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must add exactly one changelog/<PR>.md file; found ${changelogPaths.length}.`,
    );
    return { errors: unique(errors), ok: false };
  }

  const owned = changelogPaths[0];
  const fileName = owned.path.slice(`${prChangelogDirectory}/`.length);
  if (!isPrChangelogFileName(fileName)) {
    errors.push(
      `${owned.path} must be a direct child of changelog/ named with the positive pull request number and .md extension.`,
    );
  }
  if (fileName !== `${input.pullRequestNumber}.md`) {
    errors.push(
      `${owned.path} must be named changelog/${input.pullRequestNumber}.md for this pull request.`,
    );
  }
  if (owned.status !== 'added') {
    errors.push(
      `${owned.path} must be a newly added immutable changelog; status was ${owned.status}.`,
    );
  }
  if (!owned.source?.trim()) {
    errors.push(`${owned.path} is missing or empty.`);
    return { errors: unique(errors), ok: false };
  }

  const parsed = parsePrChangelog(owned.source, fileName);
  if (!parsed.ok) {
    errors.push(...parsed.errors);
    return { errors: unique(errors), ok: false };
  }

  return errors.length > 0
    ? { errors: unique(errors), ok: false }
    : { bump: parsed.changelog.bump, changelog: parsed.changelog, ok: true };
}

function unique(values: string[]) {
  return [...new Set(values)];
}
