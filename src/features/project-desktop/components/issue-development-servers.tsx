import { useMemo } from 'react';
import { ExternalLink, LoaderCircle, MonitorPlay, Play, Server } from 'lucide-react';
import { Button } from '@/app/dotnaos-ui';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import { useWorktreeDevServers } from '../hooks/use-worktree-dev-servers';
import type {
  IssueMachineConnectorOption,
  IssueMachineProjectRow
} from './issue-development-machine-actions';
import {
  findDesignSpaceProject,
  issueDevelopmentEmptyState,
  issueDevelopmentSurfaces,
  type IssueDevelopmentSurface
} from './issue-development-server-model';

function ServerSurfaceRow({
  isPending,
  onStart,
  surface
}: {
  isPending: boolean;
  onStart(): void;
  surface: IssueDevelopmentSurface;
}) {
  const isTransitioning = surface.server.state === 'starting' || surface.server.state === 'stopping';
  const canStart = surface.server.state === 'stopped' || surface.server.state === 'error';
  const stateLabel = surface.server.state === 'running'
    ? 'Running · preview unavailable'
    : surface.server.state === 'starting'
      ? 'Starting…'
      : surface.server.state === 'stopping'
        ? 'Stopping…'
        : undefined;

  return (
    <div className="min-w-0 py-0.5">
      <div className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-xs">
        <span
          aria-label={surface.url ? 'Preview ready' : surface.server.state}
          className={`size-2 shrink-0 rounded-full ${surface.url ? 'bg-emerald-400' : isTransitioning ? 'bg-blue-400' : surface.server.state === 'error' ? 'bg-red-400' : surface.server.state === 'running' ? 'bg-amber-300' : 'bg-current/20'}`}
        />
        <span className="min-w-0 flex-1 truncate text-current/55">{surface.label}</span>
        {surface.url ? (
          <a
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 font-medium text-blue-300 hover:bg-current/[.06] hover:text-blue-200"
            href={surface.url}
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
  const surfaces = issueDevelopmentSurfaces(
    servers,
    { isDesignSpace }
  );

  return {
    error: runtime.error,
    isChecking: runtime.isChecking,
    rows: surfaces.map((surface) => ({
      isPending: runtime.pendingServerKey === `${surface.server.worktreeId}\u0000${surface.server.serverId}`,
      onStart: () => void runtime.start(surface.server.worktreeId, surface.server.serverId),
      surface
    }))
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

function ConnectorServerGroup({
  branchName,
  localMachineId,
  option,
  projects,
}: {
  branchName: string;
  localMachineId: string;
  option: IssueMachineConnectorOption;
  projects: ProjectSpaceRecord[];
}) {
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
  const primaryEmptyState = issueDevelopmentEmptyState({
    connectorConfigured: true,
    error: projectRuntime.error,
    hasProject: Boolean(option.project),
    isChecking: projectRuntime.isChecking,
    isOnline: option.isOnline,
    surfaceCount: projectRuntime.rows.length
  });
  const environmentLabel = option.environmentLabel || option.connectorName;
  const connectorLabel = environmentLabel.toLocaleLowerCase() === option.connectorName.toLocaleLowerCase()
    ? ''
    : option.connectorName;
  const notices = [
    projectRuntime.rows.length > 0 ? projectRuntime.error : '',
    designSpaceProject && designSpaceRuntime.error
      ? `Design Space: ${designSpaceRuntime.error}`
      : ''
  ].filter((message, index, messages) => message && messages.indexOf(message) === index);
  const isUpdating = option.isOnline && (projectRuntime.isChecking || designSpaceRuntime.isChecking);

  return (
    <div className="border-t border-current/[.06] px-3 py-1.5 first:border-t-0">
      <div className="flex min-h-8 min-w-0 items-center gap-2 text-xs">
        <span
          aria-label={option.isOnline ? 'Online' : 'Offline'}
          className={`size-2 shrink-0 rounded-full ${option.isOnline ? 'bg-emerald-400' : 'bg-current/20'}`}
        />
        <span className="min-w-0 truncate font-medium text-current/60">{environmentLabel}</span>
        {connectorLabel ? (
          <span className="min-w-0 flex-1 truncate text-[10px] text-current/30">{connectorLabel}</span>
        ) : <span className="flex-1" />}
        {isUpdating ? <LoaderCircle aria-label="Checking servers" className="size-3 animate-spin text-current/35" /> : null}
        <span className={`shrink-0 text-[10px] ${option.isOnline ? 'text-emerald-300/80' : 'text-current/30'}`}>
          {option.isOnline ? 'Online' : 'Offline'}
        </span>
      </div>
      <div className="ml-1.5 border-l border-current/[.07] pl-1.5">
        {[...projectRuntime.rows, ...designSpaceRuntime.rows].map(({ isPending, onStart, surface }) => (
          <ServerSurfaceRow
            isPending={isPending}
            key={`${surface.server.projectId}:${surface.server.worktreeId}:${surface.server.serverId}`}
            surface={surface}
            onStart={onStart}
          />
        ))}
        {primaryEmptyState ? (
          <div
            aria-live={primaryEmptyState.kind === 'checking' ? 'polite' : undefined}
            className={`min-h-8 px-2 py-1.5 text-[11px] leading-4 ${primaryEmptyState.kind === 'runtime-error' ? 'text-red-300/80' : 'text-current/35'}`}
          >
            {primaryEmptyState.message}
          </div>
        ) : null}
        {notices.map((message) => (
          <p className="px-2 py-1 text-[11px] leading-4 text-red-300/80" key={message}>{message}</p>
        ))}
      </div>
    </div>
  );
}

function MachineServerGroup({
  branchName,
  localMachineId,
  projects,
  row
}: {
  branchName: string;
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

  return (
    <div className="overflow-hidden rounded-xl border border-current/[.07] bg-current/[.02]">
      <div className="flex min-h-9 items-center gap-2 px-3 text-xs font-medium text-current/65">
        <Server className="size-3.5 text-current/30" />
        <span className="min-w-0 flex-1 truncate">{machineName}</span>
        <span className="text-[10px] font-normal text-current/30">
          {options.length} {options.length === 1 ? 'environment' : 'environments'}
        </span>
      </div>
      {options.length > 0 ? options.map((option) => (
        <ConnectorServerGroup
          branchName={branchName}
          key={option.connectorId}
          localMachineId={localMachineId}
          option={option}
          projects={projects}
        />
      )) : (
        <div className="border-t border-current/[.06] px-3 py-2 text-[11px] text-current/35">
          {noConnectorState?.message}
        </div>
      )}
    </div>
  );
}

export function IssueDevelopmentServers({
  branchName,
  localMachineId,
  machineRows,
  projects
}: {
  branchName: string;
  localMachineId: string;
  machineRows: IssueMachineProjectRow[];
  projects: ProjectSpaceRecord[];
}) {
  if (machineRows.length === 0) return null;
  return (
    <section>
      <div className="mb-2 flex h-8 items-center gap-2">
        <MonitorPlay className="size-3.5 text-current/30" />
        <h3 className="text-xs font-semibold text-current/55">Development servers</h3>
      </div>
      <div className="grid gap-1.5">
        {machineRows.map((row) => (
          <MachineServerGroup
            branchName={branchName}
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
