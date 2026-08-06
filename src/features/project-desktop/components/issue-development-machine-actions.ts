import type {
  ConnectorOverviewResult,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { resolvedProjectMachineId } from '../../../shared/project-machine-identity';

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
  connectorIds?: string[];
  physicalMachineId?: string;
  physicalMachineName?: string;
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
      machineId: resolvedProjectMachineId(candidate, localMachineId),
      project: candidate
    }));
  const matchesByMachineId = new Map(matches.map((match) => [match.machineId, match.project]));
  return (connectorOverview.physicalMachines ?? []).flatMap((physicalMachine) => {
    const connectors = physicalMachine.connectorIds
      .map((connectorId) => connectorOverview.machines.find((machine) => machine.id === connectorId))
      .filter((machine): machine is MachineRecord => Boolean(machine));
    if (connectors.length === 0) return [];

    const preferredConnector = [...connectors].sort((left, right) => {
      const leftScore = (matchesByMachineId.has(left.id) ? 4 : 0) +
        (canRunMachineCommand(left) ? 2 : 0) +
        (left.connector.status === 'local' ? 1 : 0);
      const rightScore = (matchesByMachineId.has(right.id) ? 4 : 0) +
        (canRunMachineCommand(right) ? 2 : 0) +
        (right.connector.status === 'local' ? 1 : 0);
      return rightScore - leftScore || left.id.localeCompare(right.id);
    })[0];
    if (!preferredConnector) return [];

    return [{
      connectorIds: connectors.map((connector) => connector.id),
      machine: preferredConnector,
      machineId: preferredConnector.id,
      physicalMachineId: physicalMachine.id,
      physicalMachineName: physicalMachine.name,
      project: matchesByMachineId.get(preferredConnector.id)
    }];
  });
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
