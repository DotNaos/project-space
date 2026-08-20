import {
  isPrChangelogFileName,
  parsePrChangelog,
  prChangelogDirectory,
  type PrChangelog,
} from '../changelog/pr-file';
import {
  isReleaseIntentFileName,
  parseReleaseIntent,
  releaseIntentDirectory,
} from './release-intent';
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

  const changedReleaseIntents = input.changedFiles.filter((file) =>
    file.path.startsWith(`${releaseIntentDirectory}/`) &&
    file.path.endsWith('.json'),
  );
  const changelogPaths = input.changedFiles.filter((file) =>
    file.path.startsWith(`${prChangelogDirectory}/`),
  );
  if (changedReleaseIntents.length > 0 && changelogPaths.length === 0) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must use changelog/<PR>.md with one matching release intent.`,
    );
  }
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

  if (changedReleaseIntents.length !== 1) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must add exactly one immutable release intent JSON file; found ${changedReleaseIntents.length}.`,
    );
  } else {
    const intentFile = changedReleaseIntents[0];
    const intentName = intentFile.path.slice(`${releaseIntentDirectory}/`.length);
    if (
      intentFile.status !== 'added' ||
      !isReleaseIntentFileName(intentName) ||
      !intentFile.source?.trim()
    ) {
      errors.push(
        `${intentFile.path} must be one newly added immutable lowercase-UUID release intent JSON file.`,
      );
    } else {
      const parsedIntent = parseReleaseIntent(intentFile.source, intentFile.path);
      if (!parsedIntent.ok) {
        errors.push(...parsedIntent.errors);
      } else if (
        parsedIntent.intent.intent === 'none' ||
        parsedIntent.intent.intent !== parsed.changelog.bump
      ) {
        errors.push(
          `${intentFile.path} must use the same non-none bump as ${prChangelogDirectory}/${input.pullRequestNumber}.md.`,
        );
      }
    }
  }

  return errors.length > 0
    ? { errors: unique(errors), ok: false }
    : { bump: parsed.changelog.bump, changelog: parsed.changelog, ok: true };
}

function unique(values: string[]) {
  return [...new Set(values)];
}
