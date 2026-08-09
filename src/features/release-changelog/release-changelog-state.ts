import { normalizeStableReleaseVersion } from '../../shared/release-version';

export interface ReleaseChangelogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const dismissalPrefix = 'project-space:release-changelog:dismissed';
const dismissedValue = '1';
export const releaseChangelogQueryParameter = 'release';

export function releaseChangelogDismissalKey(version: string) {
  const normalized = normalizeStableReleaseVersion(version);
  return normalized ? `${dismissalPrefix}:${normalized}` : undefined;
}

export function shouldShowReleaseChangelogCard(
  version: string,
  storage?: ReleaseChangelogStorage
) {
  const key = releaseChangelogDismissalKey(version);
  if (!key) return false;
  if (!storage) return true;

  try {
    return storage.getItem(key) !== dismissedValue;
  } catch {
    return true;
  }
}

export function dismissReleaseChangelogCard(
  version: string,
  storage?: ReleaseChangelogStorage
) {
  const key = releaseChangelogDismissalKey(version);
  if (!key || !storage) return;

  try {
    storage.setItem(key, dismissedValue);
  } catch {
    // A blocked storage API must not prevent the user from closing the card now.
  }
}

export function releaseChangelogVersionFromSearch(search: string) {
  const value = new URLSearchParams(search).get(releaseChangelogQueryParameter);
  return value ? normalizeStableReleaseVersion(value) : undefined;
}
