import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { getProjectMachineId } from './project-main-model';

export interface ProjectBranchUsage {
  branchName: string;
  hasUncommittedChanges: boolean;
  kind: 'main' | 'worktree';
  machineId: string;
  machineName: string;
  path: string;
  staged: number;
  status: string;
  unstaged: number;
  untracked: number;
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

function relativePathUnderProjects(path: string) {
  const normalizedPath = normalizeRelativePath(path);
  const marker = 'projects/';
  const markerIndex = normalizedPath.lastIndexOf(marker);

  return markerIndex >= 0 ? normalizedPath.slice(markerIndex + marker.length) : '';
}

export function canonicalRepositoryName(
  project: ProjectSpaceRecord,
  repository?: GitHubCatalogRepository
) {
  return repository?.name || project.github?.name || project.name.split('/').pop() || basename(project.rootPath);
}

export function defaultRepositoryBranch(
  project: ProjectSpaceRecord,
  repository?: GitHubCatalogRepository
) {
  return repository?.defaultBranch || project.github?.defaultBranch || 'main';
}

export function findProjectBranchUsages({
  branchName,
  connectorOverview,
  defaultBranch,
  projects,
  repositoryName
}: {
  branchName: string;
  connectorOverview: ConnectorOverviewResult;
  defaultBranch: string;
  projects: ProjectSpaceRecord[];
  repositoryName: string;
}): ProjectBranchUsage[] {
  const localMachineId =
    connectorOverview.machines.find((machine) => machine.connector.status === 'local')?.id ??
    connectorOverview.machines[0]?.id ??
    'local';
  const machineById = new Map(connectorOverview.machines.map((machine) => [machine.id, machine]));
  const normalizedBranch = normalizeKey(branchName);

  return projects
    .filter((project) => project.kind !== 'github' && project.rootPath)
    .flatMap((project) => {
      const relativePath = relativePathUnderProjects(project.rootPath);

      if (!relativePath) {
        return [];
      }

      const projectBranch = project.gitStatus?.branchName;
      const worktreePrefix = `.worktrees/${repositoryName}/`;
      const kind: ProjectBranchUsage['kind'] | undefined =
        normalizeKey(relativePath) === normalizeKey(repositoryName)
          ? 'main'
          : normalizeKey(relativePath).startsWith(normalizeKey(worktreePrefix))
            ? 'worktree'
            : undefined;

      if (!kind) {
        return [];
      }

      const pathBranch =
        kind === 'main'
          ? defaultBranch
          : relativePath.slice(worktreePrefix.length) || projectBranch || '';
      const effectiveBranch = projectBranch || pathBranch;

      if (normalizeKey(effectiveBranch) !== normalizedBranch) {
        return [];
      }

      const machineId = getProjectMachineId(project, localMachineId);
      const machine = machineById.get(machineId);
      const staged = project.gitStatus?.staged ?? 0;
      const unstaged = project.gitStatus?.unstaged ?? 0;
      const untracked = project.gitStatus?.untracked ?? 0;

      return [
        {
          branchName: effectiveBranch,
          hasUncommittedChanges: Boolean(project.gitStatus?.hasUnstagedChanges || staged > 0),
          kind,
          machineId,
          machineName: machine?.name ?? machineId,
          path: project.rootPath,
          staged,
          status: machine?.connector.status ?? 'unknown',
          unstaged,
          untracked
        }
      ];
    })
    .sort((left, right) => `${left.machineName}:${left.path}`.localeCompare(`${right.machineName}:${right.path}`));
}
