import { expect, test } from 'bun:test';
import { validateReleasePullRequest } from
  '../apps/docs/lib/releases/pull-request-gate';
import { releaseIntentDirectory } from
  '../apps/docs/lib/releases/release-intent';
import { validateMergedIntentOnlyQueueItem } from
  '../scripts/release-queue-validation';

const validPath =
  `${releaseIntentDirectory}/4a35123b-2783-4f15-a29b-05da1aa6630a.json`;

const validHistoricalItem = {
  allIntentChanges: [validPath],
  intent: 'none' as const,
  intentPaths: [validPath],
  productPaths: ['src/features/project-desktop/example.tsx'],
};

test('accepts a valid historical intent-only compatibility item', () => {
  expect(() => validateMergedIntentOnlyQueueItem(validHistoricalItem)).not.toThrow();
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

test('rejects a non-none historical intent-only item', () => {
  expect(() => validateMergedIntentOnlyQueueItem({
    ...validHistoricalItem,
    intent: 'patch',
  })).toThrow('must declare intent none');
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
        path: 'changelog/836.md',
        source,
        status: 'added',
      },
    ],
    headPackageVersion: '0.27.0',
    pullRequestNumber: 836,
  })).toMatchObject({
    bump: 'patch',
    ok: true,
  });
});
