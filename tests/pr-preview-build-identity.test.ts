import { describe, expect, test } from 'bun:test';

import { pullRequestPreviewMetadataFromBuild } from '../server/pr-preview-build-identity';

const headSha = 'a'.repeat(40);
const environment = {
  PROJECT_SPACE_PREVIEW_HEAD_SHA: headSha,
  PROJECT_SPACE_PREVIEW_MODE: '1',
  PROJECT_SPACE_PREVIEW_PR_NUMBER: '298',
  PROJECT_SPACE_PREVIEW_REPOSITORY: 'DotNaos/project-space'
};

describe('pull request Preview build identity', () => {
  test('accepts the complete exact deployment identity', () => {
    expect(
      pullRequestPreviewMetadataFromBuild(environment, headSha)
    ).toEqual({
      identity: {
        headSha,
        pullRequestNumber: 298,
        repositoryFullName: 'DotNaos/project-space'
      },
      state: 'verified'
    });
  });

  test('does not infer a Preview identity when Preview mode is off', () => {
    expect(
      pullRequestPreviewMetadataFromBuild(
        { ...environment, PROJECT_SPACE_PREVIEW_MODE: undefined },
        headSha
      )
    ).toBeUndefined();
  });

  test('rejects metadata whose head does not match the running build', () => {
    expect(
      pullRequestPreviewMetadataFromBuild(environment, 'b'.repeat(40))
    ).toEqual({
      reasonCode: 'head-mismatch',
      state: 'invalid'
    });
  });

  test('rejects incomplete or malformed deployment metadata', () => {
    expect(
      pullRequestPreviewMetadataFromBuild(
        { ...environment, PROJECT_SPACE_PREVIEW_PR_NUMBER: '0' },
        headSha
      )
    ).toEqual({
      reasonCode: 'invalid-identity',
      state: 'invalid'
    });
    expect(
      pullRequestPreviewMetadataFromBuild(
        { ...environment, PROJECT_SPACE_PREVIEW_REPOSITORY: 'not-a-repository' },
        headSha
      )
    ).toEqual({
      reasonCode: 'invalid-identity',
      state: 'invalid'
    });
    expect(
      pullRequestPreviewMetadataFromBuild(
        { ...environment, PROJECT_SPACE_PREVIEW_HEAD_SHA: 'short' },
        headSha
      )
    ).toEqual({
      reasonCode: 'invalid-identity',
      state: 'invalid'
    });
  });

  test('reports an unavailable running commit explicitly', () => {
    expect(
      pullRequestPreviewMetadataFromBuild(environment)
    ).toEqual({
      reasonCode: 'build-commit-unavailable',
      state: 'invalid'
    });
  });
});
