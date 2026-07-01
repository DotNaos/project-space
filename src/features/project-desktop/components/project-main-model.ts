import type {
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubRepositoryDetailsResult,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';

export function getProjectTimestamp(project: ProjectSpaceRecord) {
  const value = project.github?.updatedAt ?? project.github?.pushedAt;
  const timestamp = value ? Date.parse(value) : NaN;

  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function formatRelativeTime(timestamp: number) {
  if (!timestamp) {
    return '';
  }

  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));

  if (minutes < 1) {
    return 'now';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h`;
  }

  return `${Math.round(hours / 24)}d`;
}

export function machineSubtitle(machine: MachineRecord) {
  return [machine.kind, machine.profile, machine.network.localName].filter(Boolean).join(' / ');
}

export function getMachineId(project: ProjectSpaceRecord) {
  return project.id.includes(':') ? project.id.slice(0, project.id.indexOf(':')) : 'local';
}

export function getProjectMachineId(project: ProjectSpaceRecord, localMachineId: string) {
  const machineId = getMachineId(project);
  return machineId === 'local' ? localMachineId : machineId;
}

export function formatOptionalTime(value?: string) {
  if (!value) {
    return 'not seen';
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value;
  }

  return formatRelativeTime(timestamp);
}

export function isVisibleProject(project: ProjectSpaceRecord) {
  if (project.kind === 'github') {
    return true;
  }

  const folder = project.rootPath.split('/').filter(Boolean).pop() ?? '';

  return !folder.startsWith('.') && !folder.endsWith('.worktrees');
}

function basenamePath(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function projectMatchesRepository(project: ProjectSpaceRecord, repo: GitHubCatalogRepository) {
  const projectName = normalizeKey(project.name);
  const projectFolder = normalizeKey(basenamePath(project.rootPath));
  const repoFullName = normalizeKey(repo.fullName);
  const repoName = normalizeKey(repo.name);

  return (
    projectName === repoFullName ||
    projectName === repoName ||
    projectFolder === repoFullName ||
    projectFolder === repoName
  );
}

export function resolveProjectRepository(
  project: ProjectSpaceRecord | undefined,
  githubCatalog: GitHubCatalogResult
) {
  if (!project || githubCatalog.status !== 'connected') {
    return project?.github;
  }

  return (
    project.github ??
    githubCatalog.repositories.find((repo) => projectMatchesRepository(project, repo))
  );
}

export function repositoryDetailsFallback(
  status: GitHubCatalogResult['status']
): GitHubRepositoryDetailsResult {
  return {
    branches: [],
    checkedAt: new Date().toISOString(),
    issues: [],
    status
  };
}
