import type { PrototypeScenarioKind } from './prototype-canvas';

export const prototypeReviewLocalChangelogSchema =
  'project-space.prototype-review-local-changelog/v2' as const;

export interface PrototypeReviewReleaseChange {
  category: string;
  items: readonly string[];
}

export interface PrototypeReviewReleaseEntry {
  areas: readonly string[];
  breakingChanges: readonly string[];
  changes: readonly PrototypeReviewReleaseChange[];
  issues: readonly number[];
  path: string;
  previewTests: readonly string[];
  pullRequest: number;
  summary: string;
  title: string;
  upgrade: 'none' | 'required';
  upgradeNotes: readonly string[];
  version: string;
}

export type PrototypeReviewReleaseEntryState =
  | { entry: PrototypeReviewReleaseEntry; state: 'available' }
  | {
      path?: string;
      reason: 'no-entry' | 'no-pull-request';
      state: 'missing';
    }
  | { errors: readonly string[]; path: string; state: 'invalid' }
  | {
      reason: 'pr-discovery-unavailable' | 'workspace-unavailable';
      state: 'unavailable';
    };

export interface PrototypeReviewChecklistItem {
  id: PrototypeScenarioKind;
  label: string;
  reviewed: boolean;
}

export function prototypeReviewChecklist(
  stored: readonly PrototypeReviewChecklistItem[] = []
): PrototypeReviewChecklistItem[] {
  const storedById = new Map(stored.map((item) => [item.id, item]));
  return [{
    id: 'ready',
    label: 'Current prototype',
    reviewed: storedById.get('ready')?.reviewed ?? false
  }];
}

export interface PrototypeReviewLocalChangelogSnapshot {
  branchName: string;
  checkedAt: string;
  entry: PrototypeReviewReleaseEntryState;
  headSha: string;
  issueNumber?: number;
  pullRequestNumber?: number;
  repositoryFullName: string;
  review: {
    items: readonly PrototypeReviewChecklistItem[];
    savedAt?: string;
    storagePath: string;
    writable: true;
  };
  schema: typeof prototypeReviewLocalChangelogSchema;
}

export interface SavePrototypeReviewChecklistRequest {
  items: readonly PrototypeReviewChecklistItem[];
}

export function isPrototypeReviewLocalChangelogSnapshot(
  value: unknown
): value is PrototypeReviewLocalChangelogSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === prototypeReviewLocalChangelogSchema &&
    typeof record.branchName === 'string' &&
    /^[0-9a-f]{40}$/i.test(String(record.headSha)) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(record.repositoryFullName)) &&
    Boolean(record.entry && typeof record.entry === 'object') &&
    Boolean(record.review && typeof record.review === 'object');
}
