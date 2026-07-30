export const releaseBumps = ['patch', 'minor', 'major'] as const;
export const releaseAreas = [
  'cli',
  'api',
  'web',
  'docs',
  'deploy',
  'machines',
  'security',
] as const;
export const releaseChangeCategories = [
  'Added',
  'Changed',
  'Fixed',
  'Deprecated',
  'Removed',
  'Security',
] as const;

export type ReleaseBump = (typeof releaseBumps)[number];
export type ReleaseArea = (typeof releaseAreas)[number];
export type ReleaseChangeCategory =
  (typeof releaseChangeCategories)[number];
export type ReleaseUpgrade = 'none' | 'required';

export interface ReleaseChange {
  category: ReleaseChangeCategory;
  items: string[];
}

export interface ReleaseEntry {
  areas: ReleaseArea[];
  breaking: boolean;
  breakingChanges: string[];
  bump: ReleaseBump;
  changes: ReleaseChange[];
  fileName: string;
  issues: number[];
  previewTests: string[];
  pullRequest: number;
  summary: string;
  title: string;
  upgrade: ReleaseUpgrade;
  upgradeNotes: string[];
  version: string;
}

export type PublishedReleaseEntry = Omit<
  ReleaseEntry,
  'previewTests'
>;

export interface ReleaseEntryParseSuccess {
  entry: ReleaseEntry;
  ok: true;
}

export interface ReleaseEntryParseFailure {
  errors: string[];
  ok: false;
}

export type ReleaseEntryParseResult =
  | ReleaseEntryParseSuccess
  | ReleaseEntryParseFailure;

export interface ReleaseCatalog {
  entries: ReleaseEntry[];
  versions: Map<string, ReleaseEntry>;
}

export interface ReleasePublication {
  commit: string;
  githubReleaseUrl: string;
  publishedAt: string;
  sourceRevision: string;
  status: 'Latest' | 'Prerelease' | 'Published';
  tag: string;
  version: string;
}
