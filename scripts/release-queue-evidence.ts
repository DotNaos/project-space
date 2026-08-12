import { basename } from 'node:path';
import {
  compareStableSemver,
  parseStableSemver,
} from '../apps/docs/lib/releases/semver';
import type { PublishedRelease, ReservedTag } from './release-queue-state';
import {
  parseReleaseTombstone,
  releaseTombstoneDirectory,
  validateReleaseTombstoneDirectoryHistory,
  validateReleaseTombstoneHistory,
} from './release-tombstone';
import {
  verifyReleaseTombstoneFromGitHub,
  type TombstoneGitHubFetch,
} from './release-tombstone-github';

export type ReleaseGitOutput = (
  args: string[],
  trim?: boolean,
) => string;

export function tagReservations(input: {
  currentMain: string;
  gitOutput: ReleaseGitOutput;
  publishedVersion: string;
}): ReservedTag[] {
  return input.gitOutput([
    'tag', '--merged', input.currentMain, '--list', 'v*',
  ]).split('\n').filter(Boolean).flatMap((tag) => {
    const version = tag.startsWith('v') ? tag.slice(1) : '';
    if (
      !parseStableSemver(version) ||
      compareStableSemver(version, input.publishedVersion) <= 0
    ) return [];
    return [{
      commit: requiredCommit(
        input.gitOutput(['rev-list', '-n', '1', tag]),
        `${tag} target`,
      ),
      tag,
    }];
  }).sort((left, right) =>
    compareStableSemver(left.tag.slice(1), right.tag.slice(1))
  );
}

export async function activeReleaseTombstones(input: {
  currentMain: string;
  githubFetch: TombstoneGitHubFetch;
  gitOutput: ReleaseGitOutput;
  published: PublishedRelease;
}) {
  const paths = input.gitOutput([
    'ls-tree', '-r', '--name-only', input.currentMain, '--',
    releaseTombstoneDirectory,
  ]).split('\n').filter(Boolean);
  const deletedPaths = input.gitOutput([
    'log', '--format=', '--name-only', '--diff-filter=D', '--no-renames',
    input.currentMain, '--', releaseTombstoneDirectory,
  ]).split('\n').filter(Boolean);
  validateReleaseTombstoneDirectoryHistory({
    currentPaths: paths,
    deletedPaths,
  });
  const tombstones = paths.map((path) => {
    const commits = input.gitOutput([
      'log', '--format=%H', input.currentMain, '--', path,
    ]).split('\n').filter(Boolean);
    const status = commits.length === 1
      ? input.gitOutput([
          'diff', '--name-status', '--no-renames', `${commits[0]}^1`,
          commits[0], '--', path,
        ])
      : '';
    validateReleaseTombstoneHistory({ commits, path, status });
    return parseReleaseTombstone(
      input.gitOutput(['show', `${input.currentMain}:${path}`], false),
      basename(path),
    );
  });
  const active = tombstones.filter((tombstone) =>
    compareStableSemver(tombstone.tag.slice(1), input.published.version) > 0
  );
  for (const tombstone of active) {
    await verifyReleaseTombstoneFromGitHub(tombstone, input.githubFetch);
  }
  return active;
}

export function manifestIssuedAt(value: unknown) {
  if (
    !isRecord(value) || !isRecord(value.manifest) ||
    typeof value.manifest.issuedAt !== 'string'
  ) throw new Error('Signed release manifest has no issuance time.');
  const issuedAt = Date.parse(value.manifest.issuedAt);
  if (!Number.isFinite(issuedAt)) {
    throw new Error('Signed release manifest has an invalid issuance time.');
  }
  return issuedAt;
}

function requiredCommit(value: string, label: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be a full lowercase Git commit SHA.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
