import { connectorReleaseSensitivePaths } from
  '../../../../packaging/release/connector-release-paths';
import {
  isReleaseIntentFileName,
  parseReleaseIntent,
  releaseIntentDirectory,
  releaseIntentEnforcementPath,
  releaseIntentEnforcementSource,
  type ReleaseIntent,
} from './release-intent';

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
  | { intent: ReleaseIntent; ok: true }
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
    file.path.startsWith(releaseEntryDirectory) && file.path.endsWith('.mdx')
  );
  if (changedEntries.length > 0) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must not change historical release entries: ${changedEntries.map(({ path }) => path).join(', ')}.`,
    );
  }

  const enforcementChanges = input.changedFiles.filter(
    ({ path }) => path === releaseIntentEnforcementPath,
  );
  if (
    enforcementChanges.length > 1 ||
    enforcementChanges.some(({ source, status }) =>
      status !== 'added' || source !== releaseIntentEnforcementSource)
  ) {
    errors.push(
      `${releaseIntentEnforcementPath} is an immutable adoption marker.`,
    );
  }

  const changedIntentPaths = input.changedFiles.filter((file) =>
    file.path.startsWith(`${releaseIntentDirectory}/`) &&
    file.path !== releaseIntentEnforcementPath
  );
  if (changedIntentPaths.length !== 1) {
    errors.push(
      `Pull request #${input.pullRequestNumber} must add exactly one release intent under ${releaseIntentDirectory}/; found ${changedIntentPaths.length}.`,
    );
    return { errors: unique(errors), ok: false };
  }

  const owned = changedIntentPaths[0];
  const fileName = owned.path.split('/').at(-1) ?? '';
  if (
    owned.path !== `${releaseIntentDirectory}/${fileName}` ||
    !isReleaseIntentFileName(fileName)
  ) {
    errors.push(
      `${owned.path} must be a direct child of ${releaseIntentDirectory}/ named with a canonical lowercase UUID and .json extension.`,
    );
  }
  if (owned.status !== 'added') {
    errors.push(
      `${owned.path} must be a newly added immutable release intent; status was ${owned.status}.`,
    );
  }
  if (!owned.source?.trim()) {
    errors.push(`${owned.path} is missing or empty.`);
    return { errors: unique(errors), ok: false };
  }

  const parsed = parseReleaseIntent(owned.source, owned.path);
  if (!parsed.ok) {
    errors.push(...parsed.errors);
    return { errors: unique(errors), ok: false };
  }

  if (parsed.intent.intent === 'none') {
    const sensitive = connectorReleaseSensitivePaths(
      input.changedFiles.map(({ path }) => path),
    );
    if (sensitive.length > 0) {
      errors.push(
        `Release intent "none" cannot cover connector-sensitive changes:\n${sensitive.map((path) => `- ${path}`).join('\n')}`,
      );
    }
  }

  return errors.length > 0
    ? { errors: unique(errors), ok: false }
    : { intent: parsed.intent.intent, ok: true };
}

function unique(values: string[]) {
  return [...new Set(values)];
}
