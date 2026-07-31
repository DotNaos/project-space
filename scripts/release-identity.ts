import { readFileSync } from 'node:fs';

export const releaseIdentityPaths = [
  'package.json',
  'server/connector-build-info.ts',
  'packaging/windows/test-release-packaging.ps1',
  'docs/windows-installation.md',
  'tests/connector-build-info.test.ts',
  'tests/connector-release-deployment.test.ts',
] as const;

const occurrenceContract = new Map<string, number>([
  ['package.json', 1],
  ['server/connector-build-info.ts', 1],
  ['packaging/windows/test-release-packaging.ps1', 2],
  ['docs/windows-installation.md', 1],
  ['tests/connector-build-info.test.ts', 5],
  ['tests/connector-release-deployment.test.ts', 5],
]);

export type ReleaseIdentitySources = Map<string, string>;

export function readReleaseIdentitySources(root = '.') {
  return new Map(
    releaseIdentityPaths.map((path) => [
      path,
      readFileSync(`${root}/${path}`, 'utf8'),
    ]),
  );
}

export function validateReleaseIdentityBundle(
  sources: ReleaseIdentitySources,
  version: string,
) {
  const errors: string[] = [];
  for (const path of releaseIdentityPaths) {
    const source = sources.get(path);
    const expected = occurrenceContract.get(path)!;
    if (source === undefined) {
      errors.push(`${path} is missing from the release identity bundle.`);
      continue;
    }
    const actual = occurrences(source, version);
    if (actual !== expected) {
      errors.push(
        `${path} must contain release version ${version} exactly ${expected} time${expected === 1 ? '' : 's'}; found ${actual}.`,
      );
    }
  }
  return errors;
}

export function prepareReleaseIdentityBundle(
  sources: ReleaseIdentitySources,
  currentVersion: string,
  intendedVersion: string,
) {
  const currentErrors = validateReleaseIdentityBundle(
    sources,
    currentVersion,
  );
  if (currentErrors.length > 0) {
    throw new Error(currentErrors.join('\n'));
  }
  const prepared = new Map<string, string>();
  for (const path of releaseIdentityPaths) {
    const source = sources.get(path)!;
    prepared.set(path, source.replaceAll(currentVersion, intendedVersion));
  }
  const preparedErrors = validateReleaseIdentityBundle(
    prepared,
    intendedVersion,
  );
  if (preparedErrors.length > 0) {
    throw new Error(preparedErrors.join('\n'));
  }
  return prepared;
}

export function releaseIdentityState(
  sources: ReleaseIdentitySources,
  currentVersion: string,
  intendedVersion: string,
) {
  const currentErrors = validateReleaseIdentityBundle(sources, currentVersion);
  const intendedErrors = validateReleaseIdentityBundle(sources, intendedVersion);
  if (intendedErrors.length === 0) return 'prepared' as const;
  if (currentErrors.length === 0) return 'current' as const;
  return 'partial' as const;
}

export function prepareReleaseEntryIdentity(
  source: string,
  pullRequest: number,
  version: string,
) {
  const versionToken = '__VERSION__';
  const pullRequestToken = '__PR_NUMBER__';
  const versionField = `version: "${versionToken}"`;
  const pullRequestField = `pullRequest: ${pullRequestToken}`;
  const versionTokens = occurrences(source, versionToken);
  const pullRequestTokens = occurrences(source, pullRequestToken);
  if (versionTokens === 0 && pullRequestTokens === 0) return source;
  if (
    versionTokens !== 1 ||
    pullRequestTokens !== 1 ||
    !source.includes(versionField) ||
    !source.includes(pullRequestField)
  ) {
    throw new Error(
      `${versionToken} and ${pullRequestToken} must each occur exactly once in their release-entry identity field.`,
    );
  }
  const prepared = source
    .replace(versionField, `version: "${version}"`)
    .replace(pullRequestField, `pullRequest: ${pullRequest}`);
  return prepared;
}

function occurrences(source: string, value: string) {
  if (!value) return 0;
  return source.split(value).length - 1;
}
