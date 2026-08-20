import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { validateReleasePullRequest } from
  '../apps/docs/lib/releases/pull-request-gate';
import {
  parseReleaseIntent,
  releaseIntentDirectory,
  releaseIntentEnforcementPath,
  releaseIntentEnforcementSource,
} from '../apps/docs/lib/releases/release-intent';
import {
  releaseIntentEnforcementAdoptionIntentPath,
  releaseIntentEnforcementAdoptionMergeCommit,
  releaseIntentEnforcementAdoptionSourceCommit,
  validateMergedIntentQueueItem,
  validateMergedIntentOnlyQueueItem,
  validateReleaseIntentEnforcementChange,
} from '../scripts/release-queue-validation';

const validPath =
  `${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`;
const validHistoricalItem = {
  allIntentChanges: [validPath],
  intent: 'none' as const,
  intentPaths: [validPath],
  productPaths: ['src/features/project-desktop/example.tsx'],
};

const enforcementAdoption = {
  alreadyEnforced: false,
  commit: releaseIntentEnforcementAdoptionMergeCommit,
  containsAdoptionSource: true,
  enforcementCommit: releaseIntentEnforcementAdoptionMergeCommit,
  markerAdded: true,
  markerChanged: true,
  markerMatches: true,
};

function git(...args: string[]) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function addedIntentPaths(commit: string) {
  const parent = git('rev-parse', `${commit}^1`);
  return git(
    'diff', '--name-status', '--no-renames', parent, commit, '--',
    releaseIntentDirectory,
  ).split('\n').flatMap((line) => {
    const [status, path] = line.split('\t');
    return status === 'A' && path ? [path] : [];
  });
}

test('replays the real first-parent enforcement adoption queue item', () => {
  const firstParent = git(
    'rev-parse', `${releaseIntentEnforcementAdoptionMergeCommit}^1`,
  );
  const commits = git(
    'rev-list', '--first-parent', '--reverse',
    `${firstParent}..${releaseIntentEnforcementAdoptionMergeCommit}`,
  ).split('\n');
  expect(commits).toEqual([releaseIntentEnforcementAdoptionMergeCommit]);

  const commit = commits[0];
  const addedPaths = addedIntentPaths(commit);
  const changedPaths = git(
    'diff', '--no-renames', '--name-only', firstParent, commit,
  ).split('\n');
  const enforcementCommit = commits.find((queuedCommit) =>
    addedIntentPaths(queuedCommit).includes(releaseIntentEnforcementPath)
  );
  const isAdoptionCommit = validateReleaseIntentEnforcementChange({
    alreadyEnforced: false,
    commit,
    containsAdoptionSource: git(
      'merge-base', releaseIntentEnforcementAdoptionSourceCommit, commit,
    ) === releaseIntentEnforcementAdoptionSourceCommit,
    enforcementCommit,
    markerAdded: addedPaths.includes(releaseIntentEnforcementPath),
    markerChanged: changedPaths.includes(releaseIntentEnforcementPath),
    markerMatches: git(
      'show', `${commit}:${releaseIntentEnforcementPath}`,
    ) === releaseIntentEnforcementSource.trim(),
  });
  const intentPaths = addedPaths.filter((path) => path.endsWith('.json'));
  const allIntentChanges = changedPaths.filter((path) =>
    path.startsWith(`${releaseIntentDirectory}/`) &&
    path !== releaseIntentEnforcementPath
  );
  const parsed = parseReleaseIntent(
    git('show', `${commit}:${intentPaths[0]}`),
  );
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));

  expect(isAdoptionCommit).toBe(true);
  expect(intentPaths).toEqual([releaseIntentEnforcementAdoptionIntentPath]);
  expect(() => validateMergedIntentQueueItem({
    allIntentChanges,
    commit,
    intent: parsed.intent.intent,
    intentPaths,
    isAdoptionCommit,
    productPaths: changedPaths.filter((path) =>
      path !== intentPaths[0] && path !== releaseIntentEnforcementPath
    ),
  })).not.toThrow();
});

test('rejects another otherwise-shaped enforcement-marker commit', () => {
  const commit = '1111111111111111111111111111111111111111';
  expect(() => validateReleaseIntentEnforcementChange({
    ...enforcementAdoption,
    commit,
    enforcementCommit: commit,
  })).toThrow(
    `Merged commit ${commit} changes the immutable release-intent enforcement marker.`,
  );
});

test('accepts a valid historical intent-only compatibility item', () => {
  expect(() =>
    validateMergedIntentOnlyQueueItem(validHistoricalItem)
  ).not.toThrow();
});

test.each([
  `${releaseIntentDirectory}/4A35123B-2783-4F15-A29B-05DA1AA6630A.json`,
  `${releaseIntentDirectory}/not-a-uuid.json`,
  `${releaseIntentDirectory}/.enforced`,
] as const)('rejects malformed or non-UUID historical intent filename %s', (path) => {
  expect(() => validateMergedIntentOnlyQueueItem({
    ...validHistoricalItem,
    allIntentChanges: [path],
    intentPaths: [path],
  })).toThrow('lowercase-UUID');
});

test('rejects a nested intent path even when its basename is a valid UUID', () => {
  const path =
    `${releaseIntentDirectory}/nested/4a35123b-2783-4f15-a29b-05da1aa6630a.json`;
  expect(() => validateMergedIntentOnlyQueueItem({
    ...validHistoricalItem,
    allIntentChanges: [path],
    intentPaths: [path],
  })).toThrow('lowercase-UUID');
});

test('rejects a valid intent beside another release-intent history change', () => {
  expect(() => validateMergedIntentOnlyQueueItem({
    ...validHistoricalItem,
    allIntentChanges: [validPath, `${releaseIntentDirectory}/README.md`],
  })).toThrow('lowercase-UUID');
});

test('rejects a non-none historical intent-only item', () => {
  expect(() => validateMergedIntentOnlyQueueItem({
    ...validHistoricalItem,
    intent: 'patch',
  })).toThrow('must declare intent none');
});

test('keeps generic non-none queue items outside the adoption exception', () => {
  expect(() => validateMergedIntentQueueItem({
    ...validHistoricalItem,
    commit: '1111111111111111111111111111111111111111',
    intent: 'patch',
    isAdoptionCommit: false,
  })).toThrow('must declare intent none');
});

test('rejects a recognized adoption with a noncanonical intent path', () => {
  expect(() => validateMergedIntentQueueItem({
    ...validHistoricalItem,
    commit: releaseIntentEnforcementAdoptionMergeCommit,
    intent: 'patch',
    isAdoptionCommit: true,
  })).toThrow('canonical patch queue item');
});

test('rejects a historical none intent that changes release-sensitive paths', () => {
  expect(() => validateMergedIntentOnlyQueueItem({
    ...validHistoricalItem,
    productPaths: ['cmd/project/main.go'],
  })).toThrow('release-sensitive paths');
});

test('accepts the current changelog PR contract without a release-intent file', () => {
  const source = '---\nbump: patch\n---\n\n# A useful change\n';
  expect(validateReleasePullRequest({
    basePackageVersion: '0.27.0',
    changedFiles: [
      {
        path: 'src/features/project-desktop/example.tsx',
        status: 'modified',
      },
      {
        path: 'changelog/839.md',
        source,
        status: 'added',
      },
    ],
    headPackageVersion: '0.27.0',
    pullRequestNumber: 839,
  })).toMatchObject({
    bump: 'patch',
    ok: true,
  });
});
