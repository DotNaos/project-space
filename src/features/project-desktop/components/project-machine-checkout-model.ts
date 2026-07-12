import type { ProjectSpaceRecord } from '../../../shared/project-space-api';
import type { WorktreeBranchOption } from './worktree-branch-list';

export interface MachineProjectCheckout {
  branchName?: string;
  kind: 'main' | 'worktree';
  path: string;
  project: ProjectSpaceRecord;
}

export interface MachineWorktreeInfo {
  branchName?: string;
  kind: 'main' | 'worktree';
  path: string;
}

export interface CloneTargetInfo {
  exists: boolean;
  path: string;
}

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function isDefaultBranch(branchName: string | undefined, defaultBranch: string) {
  return normalizeKey(branchName || '') === normalizeKey(defaultBranch);
}

function relativePathUnderProjects(path: string) {
  const normalizedPath = normalizeRelativePath(path);
  const marker = 'projects/';
  const markerIndex = normalizedPath.lastIndexOf(marker);
  return markerIndex >= 0 ? normalizedPath.slice(markerIndex + marker.length) : '';
}

export function checkoutForProjectPath(
  candidate: ProjectSpaceRecord,
  projectName: string,
  defaultBranch: string
): MachineProjectCheckout | undefined {
  const relativePath = relativePathUnderProjects(candidate.rootPath);
  if (!relativePath) return undefined;

  if (normalizeKey(relativePath) === normalizeKey(projectName)) {
    if (!isDefaultBranch(candidate.gitStatus?.branchName, defaultBranch)) return undefined;
    return {
      branchName: candidate.gitStatus?.branchName || defaultBranch,
      kind: 'main',
      path: candidate.rootPath,
      project: candidate
    };
  }

  const worktreePrefix = `.worktrees/${projectName}/`;
  if (!normalizeKey(relativePath).startsWith(normalizeKey(worktreePrefix))) return undefined;
  const branchPath = relativePath.slice(worktreePrefix.length);
  if (!branchPath) return undefined;
  return {
    branchName: candidate.gitStatus?.branchName || branchPath,
    kind: 'worktree',
    path: candidate.rootPath,
    project: candidate
  };
}

export function parseWorktreeOutput(output: string, mainPath: string): MachineWorktreeInfo[] {
  return output.trim().split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n').filter(Boolean);
    const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length).trim() ?? '';
    const branchRef = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length).trim();
    return {
      branchName: branchRef?.replace('refs/heads/', ''),
      kind: normalizeRelativePath(path) === normalizeRelativePath(mainPath) ? 'main' as const : 'worktree' as const,
      path
    };
  }).filter((entry) => entry.path).sort((left, right) =>
    (left.branchName || basename(left.path)).localeCompare(right.branchName || basename(right.path))
  );
}

export function parseCloneTargetProbeOutput(output: string): Record<string, CloneTargetInfo> {
  return Object.fromEntries(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [branchName, exists, path] = line.split('\t');
    return [branchName, { exists: exists === '1', path }];
  }));
}

export function branchOptions(
  branchNames: string[],
  defaultBranch: string,
  repositoryName: string,
  cloneTargets: Record<string, CloneTargetInfo> | undefined,
  worktreeByBranch: Map<string, NonNullable<WorktreeBranchOption['worktree']>>
): WorktreeBranchOption[] {
  return branchNames.map((branchName) => ({
    branchName,
    expectedPath: isDefaultBranch(branchName, defaultBranch)
      ? `~/projects/${repositoryName}`
      : `~/projects/.worktrees/${repositoryName}/${branchName}`,
    target: cloneTargets?.[branchName],
    worktree: worktreeByBranch.get(normalizeKey(branchName))
  }));
}
