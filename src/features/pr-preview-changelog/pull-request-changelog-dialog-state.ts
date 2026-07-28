import {
  isPullRequestChangelogIdentity,
  type PullRequestChangelogIdentity
} from '@/shared/pr-preview-changelog-api';

export interface PreviewChangelogDismissalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const dismissalPrefix = 'project-space:pr-preview-changelog:dismissed';
const dismissedValue = '1';

export function previewChangelogDismissalKey(
  identity: PullRequestChangelogIdentity
) {
  if (!isPullRequestChangelogIdentity(identity)) {
    return undefined;
  }

  return [
    dismissalPrefix,
    identity.repositoryFullName.toLowerCase(),
    identity.pullRequestNumber,
    identity.headSha.toLowerCase()
  ].join(':');
}

export function shouldOpenPreviewChangelog(
  identity: PullRequestChangelogIdentity,
  storage?: PreviewChangelogDismissalStorage
) {
  const key = previewChangelogDismissalKey(identity);
  if (!key) return false;
  if (!storage) return true;

  try {
    return storage.getItem(key) !== dismissedValue;
  } catch {
    return true;
  }
}

export function dismissPreviewChangelog(
  identity: PullRequestChangelogIdentity,
  storage?: PreviewChangelogDismissalStorage
) {
  const key = previewChangelogDismissalKey(identity);
  if (!key || !storage) return;

  try {
    storage.setItem(key, dismissedValue);
  } catch {
    // Storage can be unavailable in hardened browser contexts. Closing still works.
  }
}
