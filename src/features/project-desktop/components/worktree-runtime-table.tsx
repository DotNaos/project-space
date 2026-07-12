import {
  GitBranch,
  GitCommitHorizontal,
  LoaderCircle,
  PackageCheck,
  RotateCcw
} from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { MachineMembershipAccess, WorktreeDevServerRecord } from '@/shared/project-space-api';
import type { WorktreeSetupResult } from '@/shared/worktree-action-api';
import { hasPendingWorktreeSetup } from '../hooks/worktree-setup-state';
import { WorktreeDevServerAction, WorktreeDevServerDetails } from './worktree-dev-server';
import type { WorktreeRuntimeRow } from './worktree-runtime-model';

function setupTone(result: WorktreeSetupResult) {
  if (result.capability === 'unavailable') return 'bg-neutral-500';
  if (result.steps.some((step) => step.state === 'failed' || step.state === 'interrupted'))
    return 'bg-red-400';
  if (result.steps.some((step) => step.state === 'stale')) return 'bg-amber-400';
  if (result.steps.some((step) => step.state === 'running')) return 'bg-sky-400';
  if (result.steps.every((step) => step.state === 'ready')) return 'bg-emerald-400';
  return 'bg-neutral-500';
}

function setupLabel(result?: WorktreeSetupResult) {
  if (!result) return 'Checking setup';
  if (result.capability === 'unavailable') return 'No setup declared';
  if (result.steps.length === 0) return 'Ready';
  if (result.steps.every((step) => step.state === 'ready')) return 'Ready';
  if (result.steps.some((step) => step.state === 'running')) return 'Preparing';
  if (result.steps.some((step) => step.state === 'failed')) return 'Setup failed';
  if (result.steps.some((step) => step.state === 'interrupted')) return 'Interrupted';
  if (result.steps.some((step) => step.state === 'stale')) return 'Setup stale';
  return 'Setup required';
}

function nextSetupStep(result?: WorktreeSetupResult) {
  return result?.steps.find((step) => step.state !== 'ready' && step.state !== 'running');
}

function ServerSummary({ servers }: { servers: WorktreeDevServerRecord[] }) {
  if (servers.length === 0) {
    return <span className="text-xs text-neutral-600">No servers declared</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1.5">
      {servers.map((server) => (
        <span
          key={server.serverId}
          className="inline-flex min-w-0 items-center gap-1.5 text-xs text-neutral-300"
        >
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              server.state === 'running'
                ? 'bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.1)]'
                : server.state === 'error'
                  ? 'bg-red-400'
                  : server.state === 'starting' || server.state === 'stopping'
                    ? 'bg-sky-400'
                    : 'bg-neutral-600'
            )}
          />
          <span className="max-w-44 truncate">{server.serverLabel}</span>
        </span>
      ))}
    </div>
  );
}

export function WorktreeRuntimeTable({
  access,
  machineName,
  onPrepare,
  onSelect,
  onStart,
  onStop,
  pendingServerKey,
  pendingSetupKeys,
  rows,
  selectedWorktreeId,
  serversForWorktree,
  setupErrors,
  setupEnabled,
  setupResults
}: {
  access?: MachineMembershipAccess;
  machineName?: string;
  onPrepare(worktreeId: string, setupStepId: string): void;
  onSelect(worktreeId: string): void;
  onStart(worktreeId: string, serverId: string): void;
  onStop(worktreeId: string, serverId: string): void;
  pendingServerKey: string;
  pendingSetupKeys: Set<string>;
  rows: WorktreeRuntimeRow[];
  selectedWorktreeId: string;
  serversForWorktree: Map<string, WorktreeDevServerRecord[]>;
  setupErrors: Map<string, string>;
  setupEnabled: boolean;
  setupResults: Map<string, WorktreeSetupResult>;
}) {
  return (
    <div
      role="table"
      aria-label="Worktree setup and development servers"
      className="overflow-hidden rounded-xl border border-neutral-800 bg-black/20"
    >
      <div
        role="row"
        className="hidden grid-cols-[minmax(11rem,1.25fr)_minmax(9rem,.9fr)_minmax(12rem,1fr)_minmax(12rem,auto)] gap-4 border-b border-neutral-800 bg-neutral-900/55 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500 lg:grid"
      >
        <span role="columnheader">Worktree</span>
        <span role="columnheader">Setup</span>
        <span role="columnheader">Servers</span>
        <span role="columnheader" className="text-right">
          Actions
        </span>
      </div>
      <div role="rowgroup" className="divide-y divide-neutral-800/90">
        {rows.map(({ label, worktree }) => {
          const selected = worktree.id === selectedWorktreeId;
          const servers = serversForWorktree.get(worktree.id) ?? [];
          const setup = setupResults.get(worktree.id);
          const setupStep = nextSetupStep(setup);
          const actionable = worktree.status === 'ready';
          const setupPending = hasPendingWorktreeSetup(pendingSetupKeys, worktree.id);
          const setupError = setupErrors.get(worktree.id);
          return (
            <div key={worktree.id} className={cn(selected && 'bg-violet-500/[0.045]')}>
              <div
                role="row"
                className={cn(
                  'grid gap-3 px-3 py-3 transition hover:bg-white/[0.025] lg:grid-cols-[minmax(11rem,1.25fr)_minmax(9rem,.9fr)_minmax(12rem,1fr)_minmax(12rem,auto)] lg:items-center lg:gap-4 lg:px-4'
                )}
              >
                <div role="cell" className="min-w-0">
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={`${label}, ${worktree.status}`}
                    onClick={() => onSelect(worktree.id)}
                    className="flex max-w-full items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60"
                  >
                    {worktree.detached ? (
                      <GitCommitHorizontal
                        className={cn(
                          'size-4 shrink-0',
                          selected ? 'text-violet-300' : 'text-neutral-600'
                        )}
                      />
                    ) : (
                      <GitBranch
                        className={cn(
                          'size-4 shrink-0',
                          selected ? 'text-violet-300' : 'text-neutral-600'
                        )}
                      />
                    )}
                    <span className="min-w-0">
                      <Text className="block truncate text-sm font-medium text-neutral-100">
                        {label}
                      </Text>
                      <Text className="mt-0.5 block truncate text-[11px] text-neutral-600">
                        {worktree.isBase
                          ? 'Main checkout'
                          : worktree.status === 'ready'
                            ? worktree.detached
                              ? `${worktree.kind} · detached`
                              : worktree.name
                            : `${worktree.status}${worktree.statusReason ? ` · ${worktree.statusReason}` : ''}`}
                      </Text>
                    </span>
                  </button>
                </div>

                <div role="cell" className="flex min-w-0 items-center gap-2 lg:block">
                  <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-neutral-600 lg:hidden">
                    Setup
                  </span>
                  <div className="min-w-0" aria-live="polite">
                    <span className="inline-flex items-center gap-1.5 text-xs text-neutral-300">
                      {!actionable || setupError ? (
                        <span className="size-1.5 rounded-full bg-red-400" />
                      ) : !setupEnabled ? (
                        <span className="size-1.5 rounded-full bg-neutral-600" />
                      ) : setup ? (
                        <span className={cn('size-1.5 rounded-full', setupTone(setup))} />
                      ) : (
                        <LoaderCircle className="size-3 animate-spin text-neutral-600" />
                      )}
                      {!actionable || setupError
                        ? 'Unavailable'
                        : !setupEnabled
                          ? 'Authorization required'
                          : setupLabel(setup)}
                    </span>
                    {setupError ? (
                      <Text className="mt-1 block text-[11px] text-red-300/80">{setupError}</Text>
                    ) : null}
                  </div>
                </div>

                <div role="cell" className="flex min-w-0 items-start gap-2 lg:block">
                  <span className="w-16 shrink-0 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600 lg:hidden">
                    Servers
                  </span>
                  <ServerSummary servers={servers} />
                </div>

                <div role="cell" className="flex min-w-0 flex-wrap justify-end gap-2">
                  {actionable && setupStep ? (
                    <Button
                      aria-label={
                        setupStep.state === 'failed' || setupStep.state === 'interrupted'
                          ? `Retry trusted setup step ${setupStep.setupStepId}`
                          : `Prepare trusted setup step ${setupStep.setupStepId}`
                      }
                      size="sm"
                      variant="primary"
                      isDisabled={setupPending || setupStep.state === 'running'}
                      onPress={() => onPrepare(worktree.id, setupStep.setupStepId)}
                      title={setupStep.setupStepId}
                      className="bg-violet-500 text-white hover:bg-violet-400"
                    >
                      {setupPending || setupStep.state === 'running' ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : setupStep.state === 'failed' || setupStep.state === 'interrupted' ? (
                        <RotateCcw className="size-3.5" />
                      ) : (
                        <PackageCheck className="size-3.5" />
                      )}
                      <span className="max-w-36 truncate">
                        {setupStep.state === 'failed' || setupStep.state === 'interrupted'
                          ? `Retry ${setupStep.setupStepId}`
                          : `Prepare ${setupStep.setupStepId}`}
                      </span>
                    </Button>
                  ) : null}
                  {actionable &&
                  setup &&
                  (setup.capability === 'unavailable' ||
                    setup.steps.every((step) => step.state === 'ready'))
                    ? servers.map((server) => (
                        <WorktreeDevServerAction
                          key={server.serverId}
                          access={access}
                          isChecking={false}
                          isPending={pendingServerKey === `${worktree.id}\u0000${server.serverId}`}
                          onStart={() => onStart(worktree.id, server.serverId)}
                          onStop={() => onStop(worktree.id, server.serverId)}
                          server={server}
                        />
                      ))
                    : null}
                </div>
              </div>

              {actionable && selected && servers.length > 0 ? (
                <div className="border-t border-neutral-800/70 bg-black/20 py-2">
                  {servers.map((server) => (
                    <WorktreeDevServerDetails
                      key={server.serverId}
                      machineName={machineName}
                      server={server}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
