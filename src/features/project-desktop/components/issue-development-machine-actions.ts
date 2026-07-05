import type {
  ConnectorOverviewResult,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';

function basename(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeDoubleQuotedShell(value: string) {
  return value.replace(/["\\$`]/g, (character) => `\\${character}`);
}

function getMachineId(project: ProjectSpaceRecord, localMachineId: string) {
  if (project.id.includes(':')) {
    const candidate = project.id.slice(0, project.id.indexOf(':'));
    return candidate === 'local' ? localMachineId : candidate;
  }

  return localMachineId;
}

function matchesSelectedProject(
  candidate: ProjectSpaceRecord,
  selectedProject: ProjectSpaceRecord,
  repoFullName?: string
) {
  if (candidate.id === selectedProject.id) {
    return true;
  }

  const candidateName = normalizeKey(candidate.name);
  const candidateFolder = normalizeKey(basename(candidate.rootPath));
  const selectedName = normalizeKey(selectedProject.name);
  const selectedFolder = normalizeKey(basename(selectedProject.rootPath));
  const repoName = repoFullName ? normalizeKey(repoFullName.split('/').pop() ?? repoFullName) : '';
  const repoKey = repoFullName ? normalizeKey(repoFullName) : '';

  return (
    candidateName === selectedName ||
    candidateFolder === selectedFolder ||
    (repoName.length > 0 && (candidateName === repoName || candidateFolder === repoName)) ||
    (repoKey.length > 0 && (candidateName === repoKey || candidateFolder === repoKey))
  );
}

export interface IssueMachineProjectRow {
  machine?: MachineRecord;
  machineId: string;
  project?: ProjectSpaceRecord;
}

export function canRunMachineCommand(machine?: MachineRecord) {
  return machine?.connector.status === 'local' || machine?.connector.status === 'online';
}

export function machineStatusClass(status?: string) {
  if (status === 'local' || status === 'online') {
    return 'text-emerald-300';
  }

  return 'text-neutral-500';
}

export function cloneUrl(repoFullName?: string, repoUrl?: string) {
  if (repoFullName) {
    return `git@github.com:${repoFullName}.git`;
  }

  if (!repoUrl) {
    return '';
  }

  return repoUrl.endsWith('.git') ? repoUrl : `${repoUrl}.git`;
}

export function repositoryNameFromProject(project: ProjectSpaceRecord, repoFullName?: string) {
  return repoFullName?.split('/').pop() ?? basename(project.rootPath);
}

export function relativeClonePath(projectPath: string, fallbackName: string) {
  const normalized = projectPath.replace(/\/+$/, '');
  const marker = '/projects/';
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + marker.length) || fallbackName;
  }

  return fallbackName;
}

export function getIssueMachineRows({
  connectorOverview,
  project,
  projects,
  repoFullName
}: {
  connectorOverview: ConnectorOverviewResult;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repoFullName?: string;
}) {
  const localMachineId =
    connectorOverview.machines.find((machine) => machine.connector.status === 'local')?.id ??
    connectorOverview.machines[0]?.id ??
    'local';
  const matches = projects
    .filter((candidate) => candidate.kind !== 'github' && candidate.rootPath)
    .filter((candidate) => matchesSelectedProject(candidate, project, repoFullName))
    .map((candidate) => ({
      machineId: getMachineId(candidate, localMachineId),
      project: candidate
    }));
  const matchesByMachineId = new Map(matches.map((match) => [match.machineId, match.project]));
  const knownMachineIds = new Set(connectorOverview.machines.map((machine) => machine.id));
  const orphanMatches = matches
    .filter((match) => !knownMachineIds.has(match.machineId))
    .map((match) => ({
      machine: undefined,
      machineId: match.machineId,
      project: match.project
    }));

  return [
    ...connectorOverview.machines.map((machine) => ({
      machine,
      machineId: machine.id,
      project: matchesByMachineId.get(machine.id)
    })),
    ...orphanMatches
  ];
}

export function createStartDevelopmentCommand({
  branchName,
  projectPath,
  relativePath,
  repository
}: {
  branchName: string;
  projectPath?: string;
  relativePath: string;
  repository: string;
}) {
  const targetLine = projectPath
    ? `target=${shellQuote(projectPath)}`
    : `target="$HOME/projects/${escapeDoubleQuotedShell(relativePath)}"`;

  return [
    'set -e',
    targetLine,
    `branch=${shellQuote(branchName)}`,
    `repo=${shellQuote(repository)}`,
    'if [ -d "$target/.git" ]; then',
    '  cd "$target"',
    '  git fetch origin "$branch"',
    '  git checkout "$branch" 2>/dev/null || git checkout -b "$branch" "origin/$branch"',
    'else',
    '  if [ -z "$repo" ]; then echo "No clone URL available."; exit 1; fi',
    '  mkdir -p "${target%/*}"',
    '  git clone --branch "$branch" "$repo" "$target"',
    'fi',
    'if command -v code >/dev/null 2>&1; then',
    '  code "$target" >/dev/null 2>&1 &',
    '  echo "Opened $target in VS Code."',
    'else',
    '  echo "Prepared $target. VS Code CLI (code) is not installed on this machine."',
    'fi'
  ].join('\n');
}
