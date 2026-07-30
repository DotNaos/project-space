import type { ReleaseEntry } from './types';

export interface ReleasePreviewEnvironment {
  PROJECT_SPACE_BUILD_COMMIT?: string;
  PROJECT_SPACE_PREVIEW_HEAD_SHA?: string;
  PROJECT_SPACE_PREVIEW_MODE?: string;
  PROJECT_SPACE_PREVIEW_PR_NUMBER?: string;
  PROJECT_SPACE_PREVIEW_REPOSITORY?: string;
}

const fullCommit = /^[0-9a-f]{40}$/;
const repository = 'dotnaos/project-space';

export function previewTestsForExactBuild(
  entry: ReleaseEntry,
  environment: ReleasePreviewEnvironment,
  buildVersion: string | undefined,
) {
  const pullRequest = environment
    .PROJECT_SPACE_PREVIEW_PR_NUMBER?.trim();
  const head = environment
    .PROJECT_SPACE_PREVIEW_HEAD_SHA?.trim()
    .toLowerCase();
  const commit = environment
    .PROJECT_SPACE_BUILD_COMMIT?.trim()
    .toLowerCase();
  if (
    environment.PROJECT_SPACE_PREVIEW_MODE?.trim() !== '1' ||
    environment.PROJECT_SPACE_PREVIEW_REPOSITORY?.trim()
      .toLowerCase() !== repository ||
    pullRequest !== String(entry.pullRequest) ||
    !head ||
    !fullCommit.test(head) ||
    commit !== head ||
    buildVersion !== entry.version
  ) {
    return undefined;
  }
  return entry.previewTests;
}

export function publishedReleaseEntry(
  entry: ReleaseEntry,
) {
  const { previewTests: _previewTests, ...published } = entry;
  return published;
}
