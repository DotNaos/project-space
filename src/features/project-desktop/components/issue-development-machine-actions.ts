import type {
  ConnectorEnvironmentKind,
  ConnectorOverviewResult,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type {
  ComputeEnvironmentKind,
  ComputeEnvironmentRecord
} from '@/shared/compute-environment-api';
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
  const repoKey = repoFullName ? normalizeKey(repoFullName) : '';
  const candidateRepoKey = candidate.github?.fullName
    ? normalizeKey(candidate.github.fullName)
    : '';
  if (repoKey && candidateRepoKey && candidateRepoKey !== repoKey) {
    return false;
  }
  if (candidate.id === selectedProject.id) {
    return true;
  }

  const candidateName = normalizeKey(candidate.name);
  const candidateFolder = normalizeKey(basename(candidate.rootPath));
  const selectedName = normalizeKey(selectedProject.name);
  const selectedFolder = normalizeKey(basename(selectedProject.rootPath));
  const repoName = repoFullName ? normalizeKey(repoFullName.split('/').pop() ?? repoFullName) : '';

  return (
    candidateName === selectedName ||
    candidateFolder === selectedFolder ||
    (repoName.length > 0 && (candidateName === repoName || candidateFolder === repoName)) ||
    (repoKey.length > 0 && (candidateName === repoKey || candidateFolder === repoKey))
  );
}

export interface IssueMachineProjectRow {
  connectorOptions?: IssueMachineConnectorOption[];
  environmentId?: string;
  machine?: MachineRecord;
  machineId: string;
  connectorIds?: string[];
  physicalMachineId?: string;
  physicalMachineName?: string;
  project?: ProjectSpaceRecord;
  suggestedConnectorId?: string;
}

export interface IssueMachineConnectorOption {
  canRunCommand: boolean;
  connectorId: string;
  connectorName: string;
  environmentId?: string;
  environmentKind?: IssueMachineEnvironmentKind;
  environmentLabel?: string;
  environmentName?: string;
  hasProjectCheckout: boolean;
  isOnline: boolean;
  machine?: MachineRecord;
  project?: ProjectSpaceRecord;
}

export type IssueMachineEnvironmentKind = ConnectorEnvironmentKind | ComputeEnvironmentKind;

export interface IssuePhysicalMachineSummary {
  configured: number;
  online: number;
}

export function canRunMachineCommand(machine?: MachineRecord) {
  return machine?.connector.status === 'local' || machine?.connector.status === 'online';
}

function connectorEnvironmentIds(connectorOverview: ConnectorOverviewResult) {
  const associations = [...(connectorOverview.computeInventory?.connectors ?? [])]
    .sort((left, right) => (
      left.connectorId.localeCompare(right.connectorId) ||
      left.environmentId.localeCompare(right.environmentId)
    ));
  const environmentIds = new Map<string, string>();

  for (const association of associations) {
    if (!environmentIds.has(association.connectorId)) {
      environmentIds.set(association.connectorId, association.environmentId);
    }
  }

  return environmentIds;
}

function environmentKindLabel(kind?: IssueMachineEnvironmentKind) {
  switch (kind) {
    case 'macos':
    case 'native_macos':
      return 'macOS';
    case 'windows':
    case 'native_windows':
      return 'Windows';
    case 'linux':
    case 'native_linux':
      return 'Linux';
    case 'wsl':
      return 'WSL';
    case 'docker':
      return 'Docker';
    case 'devbox':
      return 'Devbox';
    case 'github_codespace':
      return 'Codespace';
    case 'cloud_sandbox':
      return 'Cloud sandbox';
    case 'kubernetes_workload':
      return 'Kubernetes';
    case 'virtual_machine':
      return 'Virtual machine';
    case 'other':
      return 'Other environment';
    default:
      return undefined;
  }
}

function environmentDisplayLabel(
  kind: IssueMachineEnvironmentKind | undefined,
  name: string | undefined
) {
  const kindLabel = environmentKindLabel(kind);
  if (!kindLabel) return name;
  if (!name) return kindLabel;

  const normalizedName = name.toLowerCase();
  const normalizedKindLabel = kindLabel.toLowerCase();
  const nameIncludesKind = normalizedName === normalizedKindLabel ||
    normalizedName.startsWith(`${normalizedKindLabel} `) ||
    normalizedName.startsWith(`${normalizedKindLabel} ·`);
  if (nameIncludesKind || kind === 'linux' || kind === 'native_linux') return name;
  return `${kindLabel} · ${name}`;
}

function environmentPresentation({
  environment,
  machine
}: {
  environment?: ComputeEnvironmentRecord;
  machine?: MachineRecord;
}) {
  const environmentKind = environment?.kind ??
    machine?.compute?.environmentKind ??
    machine?.environment?.kind;
  const environmentName = environment?.name.trim() ||
    machine?.compute?.environmentName.trim() ||
    machine?.environment?.label?.trim() ||
    undefined;
  const environmentLabel = environmentDisplayLabel(environmentKind, environmentName);

  return {
    ...(environmentKind ? { environmentKind } : {}),
    ...(environmentLabel ? { environmentLabel } : {}),
    ...(environmentName ? { environmentName } : {})
  };
}

function connectorSuggestionScore(option: IssueMachineConnectorOption) {
  return (option.canRunCommand ? 4 : 0) +
    (option.hasProjectCheckout ? 2 : 0) +
    (option.machine?.connector.status === 'local' ? 1 : 0);
}

function compareConnectorSuggestions(
  left: IssueMachineConnectorOption,
  right: IssueMachineConnectorOption
) {
  return connectorSuggestionScore(right) - connectorSuggestionScore(left) ||
    left.connectorId.localeCompare(right.connectorId);
}

export function physicalMachineSummary(
  rows: readonly IssueMachineProjectRow[]
): IssuePhysicalMachineSummary {
  const onlineByPhysicalMachine = new Map<string, boolean>();

  for (const row of rows) {
    const physicalMachineKey = row.physicalMachineId
      ?? row.physicalMachineName
      ?? row.machineId;
    const options = row.connectorOptions ?? [];
    const isOnline = options.length > 0
      ? options.some((option) => option.isOnline)
      : canRunMachineCommand(row.machine);
    onlineByPhysicalMachine.set(
      physicalMachineKey,
      Boolean(onlineByPhysicalMachine.get(physicalMachineKey)) || isOnline
    );
  }

  return {
    configured: onlineByPhysicalMachine.size,
    online: [...onlineByPhysicalMachine.values()].filter(Boolean).length
  };
}

export function onlineIssueMachineRows(
  rows: readonly IssueMachineProjectRow[]
): IssueMachineProjectRow[] {
  return rows.flatMap((row) => {
    if (row.connectorOptions === undefined) {
      return canRunMachineCommand(row.machine) ? [row] : [];
    }

    const connectorOptions = row.connectorOptions.filter((option) => option.isOnline);
    if (connectorOptions.length === 0) return [];

    const suggestedConnector = connectorOptions.find(
      (option) => option.connectorId === row.suggestedConnectorId
    ) ?? [...connectorOptions].sort(compareConnectorSuggestions)[0];

    return [{
      ...row,
      connectorIds: connectorOptions.map((option) => option.connectorId),
      connectorOptions,
      environmentId: suggestedConnector?.environmentId,
      machine: suggestedConnector?.machine,
      machineId: suggestedConnector?.connectorId ?? row.machineId,
      project: suggestedConnector?.project,
      suggestedConnectorId: suggestedConnector?.connectorId
    }];
  });
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
  const machinesByStableId = [...connectorOverview.machines]
    .sort((left, right) => left.id.localeCompare(right.id));
  const localMachineId =
    machinesByStableId.find((machine) => machine.connector.status === 'local')?.id ??
    machinesByStableId[0]?.id ??
    'local';
  const matches = projects
    .filter((candidate) => candidate.kind !== 'github' && candidate.rootPath)
    .filter((candidate) => matchesSelectedProject(candidate, project, repoFullName))
    .map((candidate) => ({
      machineId: resolvedProjectMachineId(candidate, localMachineId),
      project: candidate
    }));
  const matchesByMachineId = new Map(matches.map((match) => [match.machineId, match.project]));
  const connectorsById = new Map(
    connectorOverview.machines.map((machine) => [machine.id, machine])
  );
  const environmentIds = connectorEnvironmentIds(connectorOverview);
  const environmentsById = new Map(
    (connectorOverview.computeInventory?.environments ?? [])
      .map((environment) => [environment.id, environment])
  );
  const groupedConnectorIds = new Set(
    (connectorOverview.physicalMachines ?? []).flatMap((machine) => machine.connectorIds)
  );
  const standaloneConnectors = machinesByStableId.filter((machine) => {
    const kind = machine.compute?.environmentKind ?? machine.environment?.kind;
    const looksLikeCodespace = kind === 'github_codespace'
      || machine.kind.toLowerCase().includes('codespace')
      || machine.name.toLowerCase().includes('codespace');
    return !groupedConnectorIds.has(machine.id) && !looksLikeCodespace;
  });
  const machineGroups = [
    ...(connectorOverview.physicalMachines ?? []).map((machine) => ({
      connectorIds: machine.connectorIds,
      physicalMachineId: machine.id,
      physicalMachineName: machine.name
    })),
    ...standaloneConnectors.map((machine) => ({
      connectorIds: [machine.id],
      physicalMachineId: undefined,
      physicalMachineName: machine.name
    }))
  ];

  return machineGroups
    .map((physicalMachine) => {
      const connectorOptions = [...new Set(physicalMachine.connectorIds)]
        .map((connectorId): IssueMachineConnectorOption => {
          const machine = connectorsById.get(connectorId);
          const project = matchesByMachineId.get(connectorId);
          const isOnline = canRunMachineCommand(machine);
          const environmentId = environmentIds.get(connectorId);
          const presentation = environmentPresentation({
            environment: environmentId ? environmentsById.get(environmentId) : undefined,
            machine
          });

          return {
            canRunCommand: isOnline,
            connectorId,
            connectorName: machine?.name ?? connectorId,
            ...(environmentId ? { environmentId } : {}),
            ...presentation,
            hasProjectCheckout: Boolean(project),
            isOnline,
            machine,
            project
          };
        })
        .sort((left, right) => left.connectorId.localeCompare(right.connectorId));
      const suggestedConnector = [...connectorOptions].sort(compareConnectorSuggestions)[0];

      return {
        connectorIds: [...physicalMachine.connectorIds],
        connectorOptions,
        environmentId: suggestedConnector?.environmentId,
        machine: suggestedConnector?.machine,
        machineId: suggestedConnector?.connectorId
          ?? physicalMachine.physicalMachineId
          ?? physicalMachine.physicalMachineName,
        physicalMachineId: physicalMachine.physicalMachineId,
        physicalMachineName: physicalMachine.physicalMachineName,
        project: suggestedConnector?.project,
        suggestedConnectorId: suggestedConnector?.connectorId
      };
    })
    .sort((left, right) => {
      const leftOnline = left.connectorOptions?.some((option) => option.isOnline) ?? false;
      const rightOnline = right.connectorOptions?.some((option) => option.isOnline) ?? false;
      return Number(rightOnline) - Number(leftOnline)
        || (left.physicalMachineName ?? '').localeCompare(right.physicalMachineName ?? '')
        || (left.physicalMachineId ?? '').localeCompare(right.physicalMachineId ?? '');
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
