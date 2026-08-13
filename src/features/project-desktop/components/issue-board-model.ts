import type { GitHubIssueRecord } from '@/shared/project-space-api';
import { formatRelativeTime } from './project-main-model';

export type IssueColumnId = 'backlog' | 'blocked' | 'closed' | 'in-progress' | 'ready';
export type IssueViewMode = 'board' | 'graph' | 'list';

export interface IssueColumnDefinition {
  dotClass: string;
  dropClass: string;
  hint: string;
  id: IssueColumnId;
  label: string;
}

export const issueColumns: IssueColumnDefinition[] = [
  {
    dotClass: 'bg-neutral-500',
    dropClass: 'border-neutral-500/60 bg-neutral-500/[0.04]',
    hint: 'Not scheduled yet',
    id: 'backlog',
    label: 'Backlog'
  },
  {
    dotClass: 'bg-emerald-400',
    dropClass: 'border-emerald-400/50 bg-emerald-400/[0.04]',
    hint: 'Cleared to pick up',
    id: 'ready',
    label: 'Ready'
  },
  {
    dotClass: 'bg-sky-400',
    dropClass: 'border-sky-400/50 bg-sky-400/[0.04]',
    hint: 'Being worked on',
    id: 'in-progress',
    label: 'In progress'
  },
  {
    dotClass: 'bg-rose-400',
    dropClass: 'border-rose-400/50 bg-rose-400/[0.04]',
    hint: 'Waiting on something',
    id: 'blocked',
    label: 'Blocked'
  },
  {
    dotClass: 'bg-violet-400',
    dropClass: 'border-violet-400/50 bg-violet-400/[0.04]',
    hint: 'Completed work',
    id: 'closed',
    label: 'Closed'
  }
];

export function issueColumnById(columnId: IssueColumnId) {
  return issueColumns.find((column) => column.id === columnId) ?? issueColumns[0];
}

export type IssueColumnOverrides = Record<number, IssueColumnId>;

function derivedIssueColumn(issue: GitHubIssueRecord, index: number): IssueColumnId {
  if (issue.state === 'closed') {
    return 'closed';
  }

  const text = `${issue.title} ${issue.labels.join(' ')}`.toLowerCase();

  if (text.includes('blocked') || text.includes('blocker') || text.includes('waiting')) {
    return 'blocked';
  }

  if (text.includes('in progress') || text.includes('wip') || text.includes('doing')) {
    return 'in-progress';
  }

  if (text.includes('ready') || index < 4) {
    return 'ready';
  }

  return 'backlog';
}

export function resolveIssueColumn(
  issue: GitHubIssueRecord,
  index: number,
  overrides: IssueColumnOverrides
): IssueColumnId {
  if (issue.state === 'closed') {
    return 'closed';
  }

  const override = overrides[issue.number];
  return override && override !== 'closed'
    ? override
    : derivedIssueColumn(issue, index);
}

export function issuePlacementIndices(issues: GitHubIssueRecord[]) {
  return new Map(issues.map((issue, index) => [issue.number, index]));
}

export function resolveIssueColumnFromPlacement(
  issue: GitHubIssueRecord,
  fallbackIndex: number,
  overrides: IssueColumnOverrides,
  placementIndices: ReadonlyMap<number, number>
) {
  return resolveIssueColumn(
    issue,
    placementIndices.get(issue.number) ?? fallbackIndex,
    overrides
  );
}

export function groupIssuesByColumn(
  issues: GitHubIssueRecord[],
  overrides: IssueColumnOverrides,
  placementIssues: GitHubIssueRecord[] = issues
) {
  const groups: Record<IssueColumnId, GitHubIssueRecord[]> = {
    backlog: [],
    blocked: [],
    closed: [],
    'in-progress': [],
    ready: []
  };

  const placementIndices = issuePlacementIndices(placementIssues);

  issues.forEach((issue, fallbackIndex) => {
    groups[
      resolveIssueColumnFromPlacement(issue, fallbackIndex, overrides, placementIndices)
    ].push(issue);
  });

  return groups;
}

const columnIds = new Set<string>(issueColumns.map((column) => column.id));

export function normalizeIssueColumnOrder(order: IssueColumnId[]) {
  const seen = new Set<IssueColumnId>();
  const normalized = order.filter((columnId) => {
    if (!columnIds.has(columnId) || seen.has(columnId)) {
      return false;
    }

    seen.add(columnId);
    return true;
  });

  for (const column of issueColumns) {
    if (!seen.has(column.id)) {
      normalized.push(column.id);
    }
  }

  return normalized;
}

const columnOrderStorageKey = 'project-space:issue-board-column-order:v1';

export function loadIssueColumnOrder(): IssueColumnId[] {
  try {
    const raw = window.localStorage.getItem(columnOrderStorageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed)) {
      return issueColumns.map((column) => column.id);
    }

    return normalizeIssueColumnOrder(
      parsed.filter(
        (value): value is IssueColumnId => typeof value === 'string' && columnIds.has(value)
      )
    );
  } catch {
    return issueColumns.map((column) => column.id);
  }
}

export function saveIssueColumnOrder(order: IssueColumnId[]) {
  try {
    window.localStorage.setItem(
      columnOrderStorageKey,
      JSON.stringify(normalizeIssueColumnOrder(order))
    );
  } catch {
    // Persisting the board order is best-effort.
  }
}

export function orderedIssueColumns(order: IssueColumnId[]) {
  const byId = new Map(issueColumns.map((column) => [column.id, column]));

  return normalizeIssueColumnOrder(order)
    .map((columnId) => byId.get(columnId))
    .filter((column): column is IssueColumnDefinition => Boolean(column));
}

function boardStorageKey(repoFullName: string) {
  return `project-space:issue-board:v1:${repoFullName}`;
}

export function loadIssueColumnOverrides(repoFullName?: string): IssueColumnOverrides {
  if (!repoFullName) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(boardStorageKey(repoFullName));
    const parsed: unknown = raw ? JSON.parse(raw) : {};

    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const overrides: IssueColumnOverrides = {};

    for (const [key, value] of Object.entries(parsed)) {
      const issueNumber = Number(key);

      if (Number.isInteger(issueNumber) && typeof value === 'string' && columnIds.has(value)) {
        overrides[issueNumber] = value as IssueColumnId;
      }
    }

    return overrides;
  } catch {
    return {};
  }
}

export function saveIssueColumnOverrides(
  repoFullName: string | undefined,
  overrides: IssueColumnOverrides
) {
  if (!repoFullName) {
    return;
  }

  try {
    window.localStorage.setItem(boardStorageKey(repoFullName), JSON.stringify(overrides));
  } catch {
    // Persisting the board layout is best-effort.
  }
}

const hiddenColumnsStorageKey = 'project-space:issue-board-hidden-columns:v1';

export function loadHiddenIssueColumns(): Set<IssueColumnId> {
  try {
    const raw = window.localStorage.getItem(hiddenColumnsStorageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(
      parsed.filter(
        (value): value is IssueColumnId => typeof value === 'string' && columnIds.has(value)
      )
    );
  } catch {
    return new Set();
  }
}

export function saveHiddenIssueColumns(hidden: ReadonlySet<IssueColumnId>) {
  try {
    window.localStorage.setItem(hiddenColumnsStorageKey, JSON.stringify(Array.from(hidden)));
  } catch {
    // Persisting the column setup is best-effort.
  }
}

const viewModeStorageKey = 'project-space:issue-view-mode';

export function issueViewModeForLocation(stored: string | null, pathname: string): IssueViewMode {
  if (/\/roadmap\/?$/.test(pathname)) return 'graph';
  return stored === 'list' || stored === 'graph' ? stored : 'board';
}

export function loadIssueViewMode(): IssueViewMode {
  try {
    return issueViewModeForLocation(
      window.localStorage.getItem(viewModeStorageKey),
      window.location.pathname
    );
  } catch {
    return 'board';
  }
}

export function saveIssueViewMode(viewMode: IssueViewMode) {
  try {
    window.localStorage.setItem(viewModeStorageKey, viewMode);
  } catch {
    // Persisting the view choice is best-effort.
  }
}

function stringHue(seed: string) {
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360_000;
  }

  return hash % 360;
}

const labelChipPalette = [
  { backgroundColor: 'hsl(210 75% 56% / 0.20)', color: 'hsl(210 75% 88%)' },
  { backgroundColor: 'hsl(190 70% 48% / 0.20)', color: 'hsl(190 70% 86%)' },
  { backgroundColor: 'hsl(155 62% 44% / 0.20)', color: 'hsl(155 65% 86%)' },
  { backgroundColor: 'hsl(90 58% 45% / 0.20)', color: 'hsl(90 65% 86%)' },
  { backgroundColor: 'hsl(42 75% 52% / 0.20)', color: 'hsl(42 78% 88%)' },
  { backgroundColor: 'hsl(24 75% 54% / 0.20)', color: 'hsl(24 78% 88%)' },
  { backgroundColor: 'hsl(347 70% 58% / 0.20)', color: 'hsl(347 72% 90%)' },
  { backgroundColor: 'hsl(320 62% 58% / 0.20)', color: 'hsl(320 68% 90%)' },
  { backgroundColor: 'hsl(270 66% 62% / 0.20)', color: 'hsl(270 72% 90%)' },
  { backgroundColor: 'hsl(235 70% 64% / 0.20)', color: 'hsl(235 75% 91%)' }
] as const;

export function labelChipStyle(label: string) {
  return labelChipPalette[stringHue(label.trim().toLowerCase()) % labelChipPalette.length];
}

export function authorAvatarStyle(author: string) {
  const hue = stringHue(author.toLowerCase());

  return {
    backgroundColor: `hsl(${hue} 55% 55% / 0.22)`,
    color: `hsl(${hue} 75% 76%)`
  };
}

export function issueUpdatedAtLabel(issue: GitHubIssueRecord) {
  const timestamp = issue.updatedAt ? Date.parse(issue.updatedAt) : NaN;

  return Number.isFinite(timestamp) ? formatRelativeTime(timestamp) : '';
}

export function filterIssues(
  issues: GitHubIssueRecord[],
  query: string,
  activeLabels: ReadonlySet<string>
) {
  const normalizedQuery = query.trim().toLowerCase();

  return issues.filter((issue) => {
    if (activeLabels.size > 0 && !issue.labels.some((label) => activeLabels.has(label))) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const haystack = [
      `#${issue.number}`,
      String(issue.number),
      issue.title,
      issue.author ?? '',
      ...issue.labels
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}

export function topIssueLabels(issues: GitHubIssueRecord[], limit = 8) {
  const counts = new Map<string, number>();

  for (const issue of issues) {
    for (const label of issue.labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label]) => label);
}
