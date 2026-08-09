import type { ReleaseChangelogEntry } from '../../shared/release-changelog-api';
import { compareStableReleaseVersions } from '../../shared/release-version';

export interface ReleaseVersionMinorGroup {
  key: string;
  label: string;
  releases: ReleaseChangelogEntry[];
}

export interface ReleaseVersionMajorGroup {
  key: string;
  label: string;
  minors: ReleaseVersionMinorGroup[];
}

export function buildReleaseVersionTree(
  releases: ReleaseChangelogEntry[]
): ReleaseVersionMajorGroup[] {
  const majors = new Map<string, Map<string, ReleaseChangelogEntry[]>>();

  const newestFirst = [...releases].sort(
    (left, right) => compareStableReleaseVersions(right.version, left.version)
  );

  for (const release of newestFirst) {
    const [major, minor] = release.version.split('.');
    if (major === undefined || minor === undefined) continue;
    const minors = majors.get(major) ?? new Map<string, ReleaseChangelogEntry[]>();
    const entries = minors.get(minor) ?? [];
    entries.push(release);
    minors.set(minor, entries);
    majors.set(major, minors);
  }

  return [...majors.entries()].map(([major, minors]) => ({
    key: major,
    label: `v${major}`,
    minors: [...minors.entries()].map(([minor, releases]) => ({
      key: `${major}.${minor}`,
      label: `v${major}.${minor}`,
      releases
    }))
  }));
}
