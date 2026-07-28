import {
  isPullRequestChangelogIdentity,
  type PullRequestChangelogIdentity
} from '../src/shared/pr-preview-changelog-api';
import type { PullRequestPreviewBuildMetadata } from '../src/shared/project-space-api';

export interface PullRequestPreviewBuildEnvironment {
  PROJECT_SPACE_PREVIEW_HEAD_SHA?: string;
  PROJECT_SPACE_PREVIEW_MODE?: string;
  PROJECT_SPACE_PREVIEW_PR_NUMBER?: string;
  PROJECT_SPACE_PREVIEW_REPOSITORY?: string;
}

export function pullRequestPreviewMetadataFromBuild(
  environment: PullRequestPreviewBuildEnvironment,
  buildCommit?: string
): PullRequestPreviewBuildMetadata | undefined {
  if (environment.PROJECT_SPACE_PREVIEW_MODE?.trim() !== '1') {
    return undefined;
  }

  const pullRequest = environment.PROJECT_SPACE_PREVIEW_PR_NUMBER?.trim() ?? '';
  if (!/^[1-9][0-9]*$/.test(pullRequest)) {
    return { reasonCode: 'invalid-identity', state: 'invalid' };
  }

  const identity: PullRequestChangelogIdentity = {
    headSha: environment.PROJECT_SPACE_PREVIEW_HEAD_SHA?.trim() ?? '',
    pullRequestNumber: Number(pullRequest),
    repositoryFullName:
      environment.PROJECT_SPACE_PREVIEW_REPOSITORY?.trim() ?? ''
  };
  if (!isPullRequestChangelogIdentity(identity)) {
    return { reasonCode: 'invalid-identity', state: 'invalid' };
  }

  const normalizedBuildCommit = buildCommit?.trim().toLowerCase();
  if (!normalizedBuildCommit) {
    return {
      reasonCode: 'build-commit-unavailable',
      state: 'invalid'
    };
  }
  if (identity.headSha.toLowerCase() !== normalizedBuildCommit) {
    return { reasonCode: 'head-mismatch', state: 'invalid' };
  }

  return { identity, state: 'verified' };
}
