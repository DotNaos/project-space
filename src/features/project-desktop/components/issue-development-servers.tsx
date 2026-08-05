import { useMemo } from 'react';
import { ExternalLink, LoaderCircle, MonitorPlay, Play, Server } from 'lucide-react';
import { Button } from '@/app/dotnaos-ui';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import { useWorktreeDevServers } from '../hooks/use-worktree-dev-servers';
import type { IssueMachineProjectRow } from './issue-development-machine-actions';
import {
  findDesignSpaceProject,
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
  return (
    <div className="flex min-h-9 min-w-0 items-center gap-2 px-2 text-xs">
      <span
        aria-label={surface.url ? 'Reachable through Tailscale' : surface.server.state}
        className={`size-2 shrink-0 rounded-full ${surface.url ? 'bg-emerald-400' : isTransitioning ? 'bg-blue-400' : 'bg-current/20'}`}
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
      ) : (
        <Button
          className="h-7 min-h-7 rounded-full px-2.5"
          isDisabled={isPending || isTransitioning}
          size="sm"
          variant="ghost"
          onPress={onStart}
        >
          {isPending || isTransitioning ? <LoaderCircle className="size-3 animate-spin" /> : <Play className="size-3" />}
          {surface.server.state === 'error' ? 'Retry' : 'Start'}
        </Button>
      )}
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
  const designSpaceProject = findDesignSpaceProject(projects, row.machineId, localMachineId);
  const projectRuntime = useProjectServerSurfaces({
    branchName,
    machineId: row.machineId,
    project: row.project
  });
  const designSpaceRuntime = useProjectServerSurfaces({
    branchName,
    isDesignSpace: true,
    machineId: row.machineId,
    preferBase: true,
    project: designSpaceProject
  });
  const surfaces = [...projectRuntime.rows, ...designSpaceRuntime.rows];
  const isChecking = projectRuntime.isChecking || designSpaceRuntime.isChecking;
  const setupMessage = designSpaceProject && designSpaceRuntime.error
    ? 'Design Space needs a server declaration.'
    : projectRuntime.error && surfaces.length === 0
      ? 'Development servers are temporarily unavailable.'
      : '';

  if (surfaces.length === 0 && !isChecking && !setupMessage) return null;

  return (
    <div className="overflow-hidden rounded-2xl bg-current/[.035] py-1">
      <div className="flex min-h-9 items-center gap-2 px-3 text-xs font-medium text-current/65">
        <Server className="size-3.5 text-current/30" />
        <span className="min-w-0 flex-1 truncate">{row.physicalMachineName ?? row.machine?.name ?? row.machineId}</span>
      </div>
      {surfaces.map(({ isPending, onStart, surface }) => (
        <ServerSurfaceRow
          isPending={isPending}
          key={`${surface.server.projectId}:${surface.server.worktreeId}:${surface.server.serverId}`}
          surface={surface}
          onStart={onStart}
        />
      ))}
      {surfaces.length === 0 && isChecking ? (
        <div className="flex min-h-9 items-center gap-2 px-3 text-xs text-current/40">
          <LoaderCircle className="size-3 animate-spin" /> Checking servers…
        </div>
      ) : null}
      {setupMessage ? (
        <div className="min-h-9 px-3 py-2 text-xs text-current/40">{setupMessage}</div>
      ) : null}
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
            key={row.machineId}
            localMachineId={localMachineId}
            projects={projects}
            row={row}
          />
        ))}
      </div>
    </section>
  );
}
