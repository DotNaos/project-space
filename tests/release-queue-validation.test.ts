import { expect, test } from 'bun:test';
import { validateReleasePullRequest } from
  '../apps/docs/lib/releases/pull-request-gate';
import { releaseIntentDirectory } from
  '../apps/docs/lib/releases/release-intent';
import {
  releaseIntentEnforcementAdoptionCommit,
  validateMergedIntentOnlyQueueItem,
  validateReleaseIntentEnforcementChange,
} from '../scripts/release-queue-validation';

const validPath =
  `${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`;
const knownEnforcementAdoptionCommit =
  '299a6d583ce2d13aa0a44c9f0e3cada64c765826';

const validHistoricalItem = {
  allIntentChanges: [validPath],
  intent: 'none' as const,
  intentPaths: [validPath],
  productPaths: ['src/features/project-desktop/example.tsx'],
};

const enforcementAdoption = {
  alreadyEnforced: false,
  commit: knownEnforcementAdoptionCommit,
  enforcementCommit: knownEnforcementAdoptionCommit,
  markerAdded: true,
  markerChanged: true,
  markerMatches: true,
};

test('accepts only the known historical enforcement-adoption commit', () => {
  expect(releaseIntentEnforcementAdoptionCommit).toBe(
    knownEnforcementAdoptionCommit,
  );
  expect(validateReleaseIntentEnforcementChange(enforcementAdoption)).toBe(
    true,
  );
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
