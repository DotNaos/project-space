import { useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  LoaderCircle,
  Play,
  Wrench
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import { useWorktreeDevServers } from '../hooks/use-worktree-dev-servers';
import { useWorktreeSetup } from '../hooks/use-worktree-setup';
import {
  onlineIssueMachineRows,
  type IssueMachineConnectorOption,
  type IssueMachineProjectRow
} from './issue-development-machine-actions';
import {
  canPrepareIssueDevelopmentWorkspace,
  findDesignSpaceProject,
  isConnectorCommandChannelUnavailable,
  issueDevelopmentEmptyState,
  issueDevelopmentSurfaceRefreshAt,
  issueDevelopmentSurfaces,
  type IssueDevelopmentEmptyStateKind,
  type IssueDevelopmentSetupState,
  type IssueDevelopmentSurface
} from './issue-development-server-model';
import {
  IssueDevelopmentSetupControls,
  setupStateForWorktree
} from './issue-development-setup-controls';

function ServerSurfaceRow({
  canManage,
  isPending,
  onStart,
  setup,
  surface
}: {
  canManage: boolean;
  isPending: boolean;
  onStart(): void;
  setup: IssueDevelopmentSetupState;
  surface: IssueDevelopmentSurface;
}) {
  const previewUrl = surface.isCurrent ? surface.url : undefined;
  const isTransitioning = surface.server.state === 'starting' || surface.server.state === 'stopping';
  const canStart = surface.isCurrent && canManage && !setup.blocksStart
    && surface.server.capability === 'configured'
    && (surface.server.state === 'stopped' || surface.server.state === 'error');
  const setupLabel = setup.kind === 'checking'
    ? 'Checking setup'
    : setup.kind === 'running'
      ? 'Setup running'
      : setup.kind === 'failed'
        ? 'Setup failed'
        : setup.kind === 'required'
          ? 'Setup required'
          : setup.kind === 'error'
            ? 'Setup unavailable'
            : undefined;
  const stateLabel = !surface.isCurrent
    ? 'Status unavailable'
    : surface.server.capability === 'unavailable'
      ? 'Unavailable'
      : surface.server.state === 'running'
        ? 'Running · preview unavailable'
        : surface.server.state === 'starting'
          ? 'Starting…'
          : surface.server.state === 'stopping'
            ? 'Stopping…'
            : setup.blocksStart
              ? setupLabel
              : surface.server.state === 'error'
                ? 'Error'
                : 'Stopped';

  return (
    <div className="min-w-0 py-0.5">
      <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-xs">
        <span
          aria-label={!surface.isCurrent ? 'Status unavailable' : previewUrl ? 'Preview ready' : surface.server.state}
          className={`size-2 shrink-0 rounded-full ${!surface.isCurrent ? 'bg-current/20' : previewUrl ? 'bg-emerald-400' : isTransitioning ? 'bg-blue-400' : surface.server.state === 'error' ? 'bg-red-400' : surface.server.state === 'running' ? 'bg-amber-300' : 'bg-current/20'}`}
        />
        <span className="min-w-0 flex-1 truncate text-current/55">{surface.label}</span>
        {previewUrl ? (
          <a
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 font-medium text-blue-300 hover:bg-current/[.06] hover:text-blue-200"
            href={previewUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open <ExternalLink className="size-3" />
          </a>
        ) : canStart ? (
          <Button
            className="h-7 min-h-7 rounded-full px-2.5"
            isDisabled={isPending}
            size="sm"
            variant="ghost"
            onPress={onStart}
          >
            {isPending ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3" />}
            {surface.server.state === 'error' ? 'Retry' : 'Start'}
          </Button>
        ) : (
          <span className="shrink-0 text-[10px] text-current/35">{stateLabel}</span>
        )}
      </div>
      {surface.server.lastError ? (
        <p className="px-6 pb-1 text-[11px] leading-4 text-red-300/80">{surface.server.lastError}</p>
      ) : null}
      {surface.server.capability === 'unavailable' ? (
        <p className="px-6 pb-1 text-[11px] leading-4 text-current/35">
          Add or repair the trusted server declaration in <span className="font-mono">.project/scripts.yaml</span>.
        </p>
      ) : null}
    </div>
  );
}

function useProjectServerSurfaces({
  branchName,
  machineId,
  preferBase = false,
  project,
  isDesignSpace = false
}: {
  branchName: string;
  isDesignSpace?: boolean;
  machineId: string;
  preferBase?: boolean;
  project?: ProjectSpaceRecord;
}) {
  const runtime = useWorktreeDevServers({
    ...(!preferBase && branchName ? { branchName } : {}),
    machineId,
    ...(preferBase ? { preferBase: true } : {}),
    projectId: project?.id ?? ''
  });
  const servers = useMemo(
    () => Array.from(runtime.serversForWorktree.values()).flat(),
    [runtime.serversForWorktree]
  );
  const [, setFreshnessRevision] = useState(0);
  const refreshAt = issueDevelopmentSurfaceRefreshAt(servers);
  useEffect(() => {
    if (!refreshAt) return;
    const timer = window.setTimeout(
      () => setFreshnessRevision((current) => current + 1),
      Math.max(1, refreshAt - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [refreshAt]);
  const surfaces = issueDevelopmentSurfaces(servers, {
    hasRefreshError: Boolean(runtime.error),
    isDesignSpace
  });
  const worktreeIds = useMemo(
    () => [...new Set(servers.map((server) => server.worktreeId))],
    [servers]
  );

  return {
    error: runtime.error,
    isChecking: runtime.isChecking,
    refresh: runtime.refresh,
    rows: surfaces.map((surface) => ({
      isPending: runtime.pendingServerKey === `${surface.server.worktreeId}\u0000${surface.server.serverId}`,
      onStart: () => void runtime.start(surface.server.worktreeId, surface.server.serverId),
      surface
    })),
    worktreeIds
  };
}

function fallbackConnectorOption(row: IssueMachineProjectRow): IssueMachineConnectorOption | undefined {
  if (!row.machine && !row.project) return undefined;
  const isOnline = row.machine?.connector.status === 'local' || row.machine?.connector.status === 'online';
  return {
    canRunCommand: isOnline,
    connectorId: row.machineId,
    connectorName: row.machine?.name ?? row.machineId,
    environmentId: row.environmentId,
    environmentKind: row.machine?.environment?.kind,
    environmentLabel: row.machine?.environment?.label,
    environmentName: row.machine?.environment?.label,
    hasProjectCheckout: Boolean(row.project),
    isOnline,
    machine: row.machine,
    project: row.project
  };
}

function emptyStateNextStep(kind: IssueDevelopmentEmptyStateKind) {
  if (kind === 'no-declaration') {
    return <>Add a trusted server declaration in <span className="font-mono">.project/scripts.yaml</span>.</>;
  }
  if (kind === 'project-unavailable') {
    return <>Make the project available in this environment before starting a server.</>;
  }
  if (kind === 'connector-offline') {
    return <>Bring the connector online to inspect and start its servers.</>;
  }
  if (kind === 'no-connector') {
    return <>Attach a connector to this machine before using development servers.</>;
  }
  if (kind === 'runtime-error') {
    return <>Resolve the reported workspace problem, then check again.</>;
  }
  return undefined;
}

function ConnectorServerGroup({
  branchName,
  canManage,
  localMachineId,
  machineName,
  option,
  projects,
}: {
  branchName: string;
  canManage: boolean;
  localMachineId: string;
  machineName: string;
  option: IssueMachineConnectorOption;
  projects: ProjectSpaceRecord[];
}) {
  const [isPreparingWorkspace, setIsPreparingWorkspace] = useState(false);
  const [prepareError, setPrepareError] = useState('');
  const designSpaceProject = findDesignSpaceProject(projects, option.connectorId, localMachineId);
  const projectRuntime = useProjectServerSurfaces({
    branchName,
    machineId: option.connectorId,
    project: option.isOnline ? option.project : undefined
  });
  const designSpaceRuntime = useProjectServerSurfaces({
    branchName,
    isDesignSpace: true,
    machineId: option.connectorId,
    preferBase: true,
    project: option.isOnline ? designSpaceProject : undefined
  });
  const projectSetup = useWorktreeSetup({
    machineId: option.isOnline && option.project ? option.connectorId : undefined,
    projectId: option.project?.id ?? '',
    worktreeIds: projectRuntime.worktreeIds
  });
  const designSpaceSetup = useWorktreeSetup({
    machineId: option.isOnline && designSpaceProject ? option.connectorId : undefined,
    projectId: designSpaceProject?.id ?? '',
    worktreeIds: designSpaceRuntime.worktreeIds
  });
  const primaryEmptyState = issueDevelopmentEmptyState({
    connectorConfigured: true,
    error: projectRuntime.error,
    hasProject: Boolean(option.project),
    isChecking: projectRuntime.isChecking,
    isOnline: option.isOnline,
    surfaceCount: projectRuntime.rows.length
  });
  const environmentLabel = option.environmentLabel || option.connectorName;
  const repeatedConnectorSuffix = ` · ${option.connectorName}`;
  const compactEnvironmentLabel = environmentLabel.toLocaleLowerCase().endsWith(
    repeatedConnectorSuffix.toLocaleLowerCase()
  )
    ? environmentLabel.slice(0, -repeatedConnectorSuffix.length)
    : environmentLabel;
  let conciseEnvironmentLabel = compactEnvironmentLabel;
  if (machineName.toLowerCase().includes('local')) {
    conciseEnvironmentLabel = conciseEnvironmentLabel.replace(/\s*·\s*local$/iu, '');
  }
  if (machineName.toLowerCase().includes('codespace')) {
    conciseEnvironmentLabel = conciseEnvironmentLabel.replace(/^codespace\s*·\s*/iu, '');
  }
  const notices = [
    projectRuntime.rows.length > 0 ? projectRuntime.error : '',
    designSpaceProject && designSpaceRuntime.error
      ? `Design Space: ${designSpaceRuntime.error}`
      : ''
  ].filter((message, index, messages) => {
    if (!message) return false;
    if (isConnectorCommandChannelUnavailable(message)) return false;
    const normalized = message.replace(/^Design Space:\s*/u, '');
    if (normalized === primaryEmptyState?.message) return false;
    return messages.findIndex(
      (candidate) => candidate.replace(/^Design Space:\s*/u, '') === normalized
    ) === index;
  });
  const isUpdating = option.isOnline && (
    projectRuntime.isChecking ||
    designSpaceRuntime.isChecking ||
    projectSetup.isChecking ||
    designSpaceSetup.isChecking
  );
  const canPrepareWorkspace = Boolean(
    canManage && option.project && canPrepareIssueDevelopmentWorkspace(primaryEmptyState)
  );
  const isDisconnected = isConnectorCommandChannelUnavailable(projectRuntime.error) ||
    isConnectorCommandChannelUnavailable(designSpaceRuntime.error);
  const connectorStatus = !option.isOnline
    ? 'Offline'
    : isDisconnected
      ? 'Disconnected'
      : 'Online';

  async function prepareWorkspace() {
    if (!option.project || !canPrepareWorkspace || isPreparingWorkspace) return;
    setIsPreparingWorkspace(true);
    setPrepareError('');
    try {
      const result = await projectSpaceClient.materializeWorktree({
        branchName,
        machineId: option.connectorId,
        projectId: option.project.id
      });
      if (result.state === 'error') {
        setPrepareError(result.lastError || 'The workspace could not be prepared.');
        return;
      }
      await projectRuntime.refresh();
    } catch (error) {
      setPrepareError(
        error instanceof Error ? error.message : 'The workspace could not be prepared.'
      );
    } finally {
      setIsPreparingWorkspace(false);
    }
  }

  return (
    <div className="border-t border-current/[.06] px-1 py-1.5 first:border-t-0">
      <div className="flex min-h-8 min-w-0 items-center gap-2 text-xs">
        <span
          aria-label={connectorStatus}
          className={`size-2 shrink-0 rounded-full ${connectorStatus === 'Online' ? 'bg-emerald-400' : connectorStatus === 'Disconnected' ? 'bg-amber-300' : 'bg-current/20'}`}
        />
        <span className="min-w-0 flex-1 truncate text-current/40">
          <span className="font-medium text-current/65">{machineName}</span>
          {conciseEnvironmentLabel ? <span> · {conciseEnvironmentLabel}</span> : null}
        </span>
        {isUpdating ? <LoaderCircle aria-label="Checking servers" className="size-3 animate-spin text-current/35" /> : null}
        <span className={`shrink-0 text-[10px] ${connectorStatus === 'Online' ? 'text-emerald-300/80' : connectorStatus === 'Disconnected' ? 'text-amber-300/75' : 'text-current/30'}`}>
          {connectorStatus}
        </span>
      </div>
      <div className="ml-1.5 border-l border-current/[.07] pl-1.5">
        <IssueDevelopmentSetupControls
          canManage={canManage}
          onAfterPrepare={projectRuntime.refresh}
          setup={projectSetup}
          worktreeIds={projectRuntime.worktreeIds}
        />
        {projectRuntime.rows.map(({ isPending, onStart, surface }) => (
          <ServerSurfaceRow
            canManage={canManage}
            isPending={isPending}
            key={`${surface.server.projectId}:${surface.server.worktreeId}:${surface.server.serverId}`}
            setup={setupStateForWorktree(projectSetup, surface.server.worktreeId)}
            surface={surface}
            onStart={onStart}
          />
        ))}
        <IssueDevelopmentSetupControls
          canManage={canManage}
          label="Design Space"
          onAfterPrepare={designSpaceRuntime.refresh}
          setup={designSpaceSetup}
          worktreeIds={designSpaceRuntime.worktreeIds}
        />
        {designSpaceRuntime.rows.map(({ isPending, onStart, surface }) => (
          <ServerSurfaceRow
            canManage={canManage}
            isPending={isPending}
            key={`${surface.server.projectId}:${surface.server.worktreeId}:${surface.server.serverId}`}
            setup={setupStateForWorktree(designSpaceSetup, surface.server.worktreeId)}
            surface={surface}
            onStart={onStart}
          />
        ))}
        {primaryEmptyState && primaryEmptyState.kind !== 'connector-offline' ? (
          <div className="flex min-h-8 min-w-0 items-start gap-2 px-2 py-1.5">
            <span
              aria-live={primaryEmptyState.kind === 'checking' ? 'polite' : undefined}
              className={`min-w-0 flex-1 text-[11px] leading-4 ${primaryEmptyState.kind === 'runtime-error' ? 'text-amber-300/75' : 'text-current/35'}`}
            >
              {primaryEmptyState.message}
              {primaryEmptyState.kind !== 'checking' && primaryEmptyState.kind !== 'runtime-error' ? (
                <span className="mt-0.5 block text-current/30">
                  {emptyStateNextStep(primaryEmptyState.kind)}
                </span>
              ) : null}
            </span>
            {canPrepareWorkspace ? (
              <Button
                className="h-7 min-h-7 shrink-0 rounded-full px-2.5"
                isDisabled={isPreparingWorkspace}
                size="sm"
                variant="ghost"
                onPress={() => void prepareWorkspace()}
              >
                {isPreparingWorkspace
                  ? <LoaderCircle className="size-3 animate-spin" />
                  : <Wrench className="size-3" />}
                {isPreparingWorkspace ? 'Preparing…' : 'Prepare workspace'}
              </Button>
            ) : null}
          </div>
        ) : null}
        {prepareError ? (
          <p className="px-2 py-1 text-[11px] leading-4 text-red-300/80">{prepareError}</p>
        ) : null}
        {notices.map((message) => (
          <p className="px-2 py-1 text-[11px] leading-4 text-amber-300/75" key={message}>{message}</p>
        ))}
      </div>
    </div>
  );
}

function MachineServerGroup({
  branchName,
  canManage,
  localMachineId,
  projects,
  row
}: {
  branchName: string;
  canManage: boolean;
  localMachineId: string;
  projects: ProjectSpaceRecord[];
  row: IssueMachineProjectRow;
}) {
  const fallback = fallbackConnectorOption(row);
  const options = row.connectorOptions ?? (fallback ? [fallback] : []);
  const machineName = row.physicalMachineName ?? row.machine?.name ?? row.machineId;
  const noConnectorState = issueDevelopmentEmptyState({
    connectorConfigured: false,
    hasProject: false,
    isChecking: false,
    isOnline: false,
    surfaceCount: 0
  });

  return options.length > 0 ? options.map((option) => (
        <ConnectorServerGroup
          branchName={branchName}
          canManage={canManage}
          key={option.connectorId}
          localMachineId={localMachineId}
          machineName={machineName}
          option={option}
          projects={projects}
        />
      )) : (
        <div className="border-t border-current/[.06] px-1 py-2 text-[11px] text-current/35">
          {noConnectorState?.message}
          {noConnectorState ? (
            <span className="mt-0.5 block text-current/30">
              {emptyStateNextStep(noConnectorState.kind)}
            </span>
          ) : null}
        </div>
  );
}

export function IssueDevelopmentServers({
  branchName,
  canManage = true,
  localMachineId,
  machineRows,
  projects
}: {
  branchName: string;
  canManage?: boolean;
  localMachineId: string;
  machineRows: IssueMachineProjectRow[];
  projects: ProjectSpaceRecord[];
}) {
  const onlineMachineRows = onlineIssueMachineRows(machineRows);
  if (onlineMachineRows.length === 0) return null;
  return (
    <section>
      <div className="mb-1 flex h-8 items-center gap-2">
        <h3 className="text-xs font-semibold text-current/55">Runtime</h3>
      </div>
      <div className="border-b border-current/[.08]">
        {onlineMachineRows.map((row) => (
          <MachineServerGroup
            branchName={branchName}
            canManage={canManage}
            key={row.physicalMachineId ?? row.machineId}
            localMachineId={localMachineId}
            projects={projects}
            row={row}
          />
        ))}
      </div>
    </section>
  );
}
