export const releaseChangelogSchema =
  'project-space.release-changelog/v1' as const;

export interface ReleaseChangelogEntry {
  body: string;
  name: string;
  publishedAt: string;
  tag: string;
  url: string;
  version: string;
}

export interface ReleaseChangelogResult {
  checkedAt: string;
  currentReleaseAvailable: boolean;
  currentVersion: string;
  releases: ReleaseChangelogEntry[];
  schema: typeof releaseChangelogSchema;
}
