import { matchesFuzzyQuery } from '../../../lib/fuzzy-search';
import type { WorktreeBranchOption } from './worktree-branch-list';

function normalizeBranch(value: string) {
  return value.trim().replace(/^refs\/heads\//, '').toLocaleLowerCase();
}

function timestamp(value: string | undefined) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareNonBaseBranches(left: WorktreeBranchOption, right: WorktreeBranchOption) {
  const leftIsLocal = Boolean(left.worktree);
  const rightIsLocal = Boolean(right.worktree);
  if (leftIsLocal !== rightIsLocal) return leftIsLocal ? -1 : 1;

  const activityDifference = timestamp(right.worktree?.headCommittedAt)
    - timestamp(left.worktree?.headCommittedAt);
  if (activityDifference !== 0) return activityDifference;

  return normalizeBranch(left.branchName).localeCompare(normalizeBranch(right.branchName))
    || left.branchName.localeCompare(right.branchName);
}

export function orderedMachineBranchOptions(
  options: readonly WorktreeBranchOption[],
  defaultBranch: string
) {
  const defaultKey = normalizeBranch(defaultBranch);
  const base = options.filter((option) => normalizeBranch(option.branchName) === defaultKey);
  const branches = options
    .filter((option) => normalizeBranch(option.branchName) !== defaultKey)
    .sort(compareNonBaseBranches);
  return [...base, ...branches];
}

export function previewMachineBranchOptions(
  options: readonly WorktreeBranchOption[],
  defaultBranch: string,
  recentCount = 3
) {
  const ordered = orderedMachineBranchOptions(options, defaultBranch);
  const base = ordered.filter((option) => normalizeBranch(option.branchName) === normalizeBranch(defaultBranch));
  const recentWorktrees = ordered.filter((option) => (
    normalizeBranch(option.branchName) !== normalizeBranch(defaultBranch)
    && option.worktree?.branchName
  ));
  return [...base.slice(0, 1), ...recentWorktrees.slice(0, recentCount)];
}

export function filterMachineBranchOptions(
  options: readonly WorktreeBranchOption[],
  query: string
) {
  return options.filter((option) => matchesFuzzyQuery([
    option.branchName,
    option.worktree?.name,
    option.worktree?.path,
    option.worktree?.status,
    option.expectedPath,
    option.target?.path
  ], query));
}
