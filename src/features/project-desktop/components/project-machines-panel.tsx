import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Monitor } from 'lucide-react';
import { Disclosure } from '@heroui/react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  MachineRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { matchesFuzzyQuery } from '@/lib/fuzzy-search';
import { resolvedProjectMachineId } from '../../../shared/project-machine-identity';
import type { MachineDetailTab } from '../hooks/use-project-desktop';
import { useMachineWorktreeDiscovery } from '../hooks/use-machine-worktree-discovery';
import {
  branchOptions,
  checkoutForProjectPath,
  parseCloneTargetProbeOutput,
  type MachineProjectCheckout
} from './project-machine-checkout-model';
import type { WorktreeBranchOption } from './worktree-branch-list';
import {
  groupConnectorInstallations,
  type ConnectorInstallationPresentation
} from './machine-connector-topology-model';
import { ProjectConnectorDisclosure } from './project-connector-disclosure';
import {
  canRunConnectorCommand,
  canonicalProjectName,
  checkoutSortValue,
  cloneUrl,
  createCloneCommand,
  createCloneTargetProbeCommand,
  defaultBranchName,
  isDefaultBranch,
  mergeBranchNames,
  normalizeConnectorKey,
  primaryCheckout,
  type ConnectorCloneTargetState
} from './project-connector-inventory-model';

interface MachineProjectMatch {
  checkout: MachineProjectCheckout;
  connectorId: string;
}

interface ProjectConnectorRow {
  checkouts: MachineProjectCheckout[];
  connector?: MachineRecord;
  connectorId: string;
  presentation?: ConnectorInstallationPresentation;
}

interface ProjectPhysicalMachineRow {
  connectors: ProjectConnectorRow[];
  id: string;
  name: string;
  onlineConnectorCount: number;
}

function connectorMatches(row: ProjectConnectorRow, query: string) {
  return matchesFuzzyQuery([
    row.connectorId,
    row.presentation?.environmentLabel,
    row.presentation?.channel,
    row.connector?.name,
    row.connector?.connector.status,
    row.connector?.connector.runtime?.version,
    row.checkouts.map((checkout) => checkout.branchName).join(' '),
    row.checkouts.map((checkout) => checkout.path).join(' ')
  ], query);
}

export function ProjectMachinesPanel({
  connectorOverview,
  onOpenMachine,
  onOpenWorktreeBranch,
  project,
  projects,
  repository
}: {
  connectorOverview: ConnectorOverviewResult;
  onOpenMachine(machineId: string, tab?: MachineDetailTab): void;
  onOpenWorktreeBranch(machineId: string, branchName: string, path?: string): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repository?: GitHubCatalogRepository;
}) {
  const [actionMessage, setActionMessage] = useState('');
  const [busyCloneKey, setBusyCloneKey] = useState('');
  const [cloneTargetState, setCloneTargetState] = useState<Record<string, ConnectorCloneTargetState>>({});
  const [machineQuery, setMachineQuery] = useState('');
  const [physicalMachines, setPhysicalMachines] = useState<PhysicalMachineRecord[]>(
    connectorOverview.physicalMachines ?? []
  );
  const [physicalMachinesError, setPhysicalMachinesError] = useState('');
  const [physicalMachinesLoading, setPhysicalMachinesLoading] = useState(
    connectorOverview.physicalMachines === undefined
  );
  const [repositoryBranches, setRepositoryBranches] = useState<string[]>([]);
  const [repositoryBranchesMessage, setRepositoryBranchesMessage] = useState('');
  const repositoryName = canonicalProjectName(project, repository);
  const defaultBranch = defaultBranchName(project, repository);
  const localConnectorId = connectorOverview.machines.find(
    (connector) => connector.connector.status === 'local'
  )?.id ?? connectorOverview.machines[0]?.id ?? 'local';

  const matches = useMemo<MachineProjectMatch[]>(() => projects
    .filter((candidate) => candidate.kind !== 'github' && candidate.rootPath)
    .flatMap((candidate) => {
      const checkout = checkoutForProjectPath(candidate, repositoryName, defaultBranch);
      return checkout ? [{
        checkout,
        connectorId: resolvedProjectMachineId(candidate, localConnectorId)
      }] : [];
    }), [defaultBranch, localConnectorId, projects, repositoryName]);

  const checkoutsByConnectorId = useMemo(() => matches.reduce((map, match) => {
    const current = map.get(match.connectorId) ?? [];
    current.push(match.checkout);
    map.set(match.connectorId, current.sort((left, right) =>
      checkoutSortValue(left).localeCompare(checkoutSortValue(right))
    ));
    return map;
  }, new Map<string, MachineProjectCheckout[]>()), [matches]);

  const topology = useMemo(() => groupConnectorInstallations({
    connectors: connectorOverview.machines,
    physicalMachines
  }), [connectorOverview.machines, physicalMachines]);

  const connectorRowsById = useMemo(() => new Map<string, ProjectConnectorRow>(
    connectorOverview.machines.map((connector) => [
    connector.id,
    {
      checkouts: checkoutsByConnectorId.get(connector.id) ?? [],
      connector,
      connectorId: connector.id,
      presentation: topology.machines
        .flatMap((machine) => machine.connectors)
        .concat(topology.ungroupedConnectors)
        .find((candidate) => candidate.id === connector.id)
    } satisfies ProjectConnectorRow
    ])
  ), [checkoutsByConnectorId, connectorOverview.machines, topology]);

  const machineRows = useMemo<ProjectPhysicalMachineRow[]>(() => topology.machines.map((machine) => ({
    connectors: machine.connectors.flatMap((connector) => {
      const row = connectorRowsById.get(connector.id);
      return row ? [row] : [];
    }),
    id: machine.id,
    name: machine.name,
    onlineConnectorCount: machine.onlineConnectorCount
  })), [connectorRowsById, topology.machines]);

  const ungroupedRows = useMemo(() => {
    const knownConnectorIds = new Set(connectorOverview.machines.map((connector) => connector.id));
    const rows = topology.ungroupedConnectors.flatMap((connector) => {
      const row = connectorRowsById.get(connector.id);
      return row ? [row] : [];
    });
    for (const [connectorId, checkouts] of checkoutsByConnectorId) {
      if (!knownConnectorIds.has(connectorId)) rows.push({ checkouts, connectorId });
    }
    return rows;
  }, [checkoutsByConnectorId, connectorOverview.machines, connectorRowsById, topology.ungroupedConnectors]);

  const allConnectorRows = useMemo(
    () => [...machineRows.flatMap((machine) => machine.connectors), ...ungroupedRows],
    [machineRows, ungroupedRows]
  );
  const discoveryTargets = useMemo(() => allConnectorRows.map((row) => {
    const checkout = primaryCheckout(row.checkouts);
    return {
      blockedMessage: canRunConnectorCommand(row.connector)
        ? undefined
        : row.connector
          ? `${row.presentation?.environmentLabel || 'Connector'} is ${row.connector.connector.status}.`
          : 'Connector installation is not available.',
      machineId: row.connectorId,
      projectId: checkout?.project.id
    };
  }), [allConnectorRows]);
  const branchState = useMachineWorktreeDiscovery(discoveryTargets);
  const filteredMachineRows = useMemo(() => machineRows.flatMap((machine) => {
    const connectors = machine.connectors.filter((row) =>
      matchesFuzzyQuery([machine.id, machine.name], machineQuery) || connectorMatches(row, machineQuery)
    );
    return connectors.length > 0 || matchesFuzzyQuery([machine.id, machine.name], machineQuery)
      ? [{ ...machine, connectors: connectors.length > 0 ? connectors : machine.connectors }]
      : [];
  }), [machineQuery, machineRows]);
  const filteredUngroupedRows = useMemo(
    () => ungroupedRows.filter((row) => connectorMatches(row, machineQuery)),
    [machineQuery, ungroupedRows]
  );
  const repositoryCloneUrl = cloneUrl(repository);
  const cloneBranchNames = useMemo(() => {
    const branches = new Set([defaultBranch, ...repositoryBranches]);
    return Array.from(branches).sort((left, right) => {
      if (isDefaultBranch(left, defaultBranch)) return -1;
      if (isDefaultBranch(right, defaultBranch)) return 1;
      return left.localeCompare(right);
    });
  }, [defaultBranch, repositoryBranches]);

  useEffect(() => {
    if (connectorOverview.physicalMachines) {
      setPhysicalMachines(connectorOverview.physicalMachines);
      setPhysicalMachinesLoading(false);
      setPhysicalMachinesError('');
      return;
    }
    let canceled = false;
    setPhysicalMachinesLoading(true);
    setPhysicalMachinesError('');
    void projectSpaceClient.listPhysicalMachines().then((result) => {
      if (!canceled) setPhysicalMachines(result.machines);
    }).catch((error) => {
      if (!canceled) setPhysicalMachinesError(
        error instanceof Error ? error.message : 'Could not load physical machines.'
      );
    }).finally(() => {
      if (!canceled) setPhysicalMachinesLoading(false);
    });
    return () => { canceled = true; };
  }, [connectorOverview.physicalMachines]);

  useEffect(() => {
    if (!repository?.fullName) {
      setRepositoryBranches([]);
      setRepositoryBranchesMessage('');
      return;
    }
    let canceled = false;
    setRepositoryBranchesMessage('');
    void projectSpaceClient.getGitHubRepositoryDetails(repository.fullName).then((details) => {
      if (!canceled) setRepositoryBranches(details.branches.map((branch) => branch.name));
      if (!canceled) setRepositoryBranchesMessage(details.message ?? '');
    }).catch((error) => {
      if (!canceled) setRepositoryBranches([]);
      if (!canceled) setRepositoryBranchesMessage(
        error instanceof Error ? error.message : 'Could not load repository branches.'
      );
    });
    return () => { canceled = true; };
  }, [repository?.fullName]);

  useEffect(() => {
    let canceled = false;
    const runnableRows = allConnectorRows.filter((row) => canRunConnectorCommand(row.connector));
    if (cloneBranchNames.length === 0 || runnableRows.length === 0) {
      setCloneTargetState({});
      return;
    }
    void Promise.all(runnableRows.map(async (row) => {
      const result = await projectSpaceClient.runMachineTerminalCommand({
        command: createCloneTargetProbeCommand(cloneBranchNames, defaultBranch, repositoryName),
        machineId: row.connectorId
      });
      return {
        key: row.connectorId,
        state: result.exitCode === 0
          ? { targets: parseCloneTargetProbeOutput(result.stdout) }
          : { error: result.stderr || 'Could not inspect clone targets.', targets: {} }
      };
    })).then((results) => {
      if (!canceled) setCloneTargetState(Object.fromEntries(results.map((result) => [result.key, result.state])));
    });
    return () => { canceled = true; };
  }, [allConnectorRows, cloneBranchNames, defaultBranch, repositoryName]);

  async function cloneToConnector(connectorId: string, branchName: string) {
    setActionMessage('');
    setBusyCloneKey(`${connectorId}:${branchName}`);
    const result = await projectSpaceClient.runMachineTerminalCommand({
      command: createCloneCommand({ branchName, defaultBranch, repository: repositoryCloneUrl, repositoryName }),
      machineId: connectorId
    });
    setBusyCloneKey('');
    setActionMessage(result.exitCode === 0
      ? `${branchName} cloned through the selected connector. Refresh after it reports the checkout.`
      : result.stderr || result.stdout || 'Clone could not be started through this connector.');
  }

  function renderConnector(row: ProjectConnectorRow, defaultExpanded = false) {
    const state = branchState[row.connectorId];
    const checkout = primaryCheckout(row.checkouts);
    const worktrees = state?.state === 'ready' ? state.worktrees : [];
    const worktreeByBranch = new Map<string, NonNullable<WorktreeBranchOption['worktree']>>(
      worktrees.map((worktree) => [normalizeConnectorKey(worktree.branchName || worktree.name), {
        branchName: worktree.branchName,
        headCommittedAt: worktree.headCommittedAt,
        id: worktree.id,
        isBase: worktree.isBase,
        name: worktree.name,
        path: worktree.path,
        status: worktree.status,
        statusReason: worktree.statusReason
      }])
    );
    const targetState = cloneTargetState[row.connectorId];
    const branches = branchOptions(
      mergeBranchNames(defaultBranch, cloneBranchNames, worktrees),
      defaultBranch,
      repositoryName,
      targetState?.targets,
      worktreeByBranch
    );
    const targetCheckPending = canRunConnectorCommand(row.connector) && !targetState;
    const canClone = Boolean(repositoryCloneUrl) && canRunConnectorCommand(row.connector) &&
      !targetCheckPending && !targetState?.error;
    return (
      <ProjectConnectorDisclosure
        key={row.connectorId}
        branches={branches}
        busyBranchName={busyCloneKey.startsWith(`${row.connectorId}:`)
          ? busyCloneKey.slice(row.connectorId.length + 1)
          : ''}
        canClone={canClone}
        checkouts={row.checkouts}
        connector={row.connector}
        connectorId={row.connectorId}
        defaultBranch={defaultBranch}
        defaultExpanded={defaultExpanded}
        environmentLabel={row.presentation?.environmentLabel}
        onCloneBranch={(branchName) => void cloneToConnector(row.connectorId, branchName)}
        onOpenConnector={() => onOpenMachine(row.connectorId, 'projects')}
        onSelectBase={() => onOpenWorktreeBranch(row.connectorId, defaultBranch, checkout?.path)}
        onSelectBranch={(branchName, path) => onOpenWorktreeBranch(row.connectorId, branchName, path)}
        onSelectWorktree={(worktreeId) => {
          const branch = branches.find((option) => option.worktree?.id === worktreeId);
          if (branch) onOpenWorktreeBranch(row.connectorId, branch.branchName, branch.worktree?.path);
        }}
        projectName={repositoryName}
        repositoryMessage={repositoryBranchesMessage}
        state={state}
        targetCheckPending={targetCheckPending}
        targetError={targetState?.error}
      />
    );
  }

  const resultCount = filteredMachineRows.length + filteredUngroupedRows.length;
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-neutral-950/45 px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Monitor className="size-4 shrink-0 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Project machines</Text>
          </div>
          <Text className="text-xs text-neutral-500">
            {physicalMachinesLoading
              ? 'Loading machines…'
              : `${machineRows.length} ${machineRows.length === 1 ? 'machine' : 'machines'} · ${allConnectorRows.length} connectors`}
          </Text>
        </div>
        {physicalMachinesError ? <Text className="mt-2 block text-xs text-amber-300">{physicalMachinesError}</Text> : null}
        {actionMessage ? <Text className="mt-2 block text-xs text-neutral-500">{actionMessage}</Text> : null}
      </Surface>

      <SearchField aria-label="Search machines and connectors" value={machineQuery} onChange={setMachineQuery}>
        <SearchFieldGroup className="rounded-lg bg-neutral-900/80">
          <SearchFieldSearchIcon />
          <SearchFieldInput className="text-sm" placeholder="Search machines and connectors" spellCheck={false} />
          <SearchFieldClearButton />
        </SearchFieldGroup>
      </SearchField>

      {!physicalMachinesLoading && allConnectorRows.length === 0 ? (
        <Text className="px-1 py-4 text-sm text-neutral-500">No connector installations are registered yet.</Text>
      ) : !physicalMachinesLoading && resultCount === 0 ? (
        <Text className="px-1 py-4 text-sm text-neutral-500">No machines or connectors found.</Text>
      ) : (
        <div className="grid gap-3">
          {filteredMachineRows.map((machine) => (
            <Surface key={machine.id} variant="tertiary" className="min-w-0 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/45">
              <Disclosure defaultExpanded>
                <Disclosure.Heading>
                  <Disclosure.Trigger className="group grid min-h-11 w-full min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] items-center px-2 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400/60 sm:px-3">
                    <span className="flex min-h-11 items-center justify-center">
                      <Disclosure.Indicator className="size-4 text-neutral-500 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none">
                        <ChevronRight />
                      </Disclosure.Indicator>
                    </span>
                    <span className="min-w-0">
                      <Text className="block truncate text-sm font-semibold text-neutral-100">{machine.name}</Text>
                      <Text className="block truncate text-xs text-neutral-500">
                        {machine.onlineConnectorCount} of {machine.connectors.length} connectors online
                      </Text>
                    </span>
                  </Disclosure.Trigger>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="min-w-0">
                    {machine.connectors.map((connector, index) => renderConnector(
                      connector,
                      index === machine.connectors.findIndex((candidate) => candidate.checkouts.length > 0)
                    ))}
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            </Surface>
          ))}

          {filteredUngroupedRows.length > 0 ? (
            <Surface variant="tertiary" className="min-w-0 overflow-hidden rounded-lg border border-amber-500/20 bg-neutral-950/45">
              <div className="px-4 py-3">
                <Text className="block text-sm font-semibold text-neutral-200">Ungrouped connector installations</Text>
                <Text className="block text-xs text-neutral-500">Assign these connectors to a physical machine in Settings.</Text>
              </div>
              {filteredUngroupedRows.map((connector, index) => renderConnector(connector, index === 0))}
            </Surface>
          ) : null}
        </div>
      )}
    </div>
  );
}
