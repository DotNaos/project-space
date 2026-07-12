import { ExternalLink, GitBranch, GitCommitHorizontal } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import type { DeployedEnvironmentStatus, GitHubWorkflowRunSummary } from '@/shared/project-space-api';
import { formatDuration, isCurrentDeploymentRun, isHistoricalFailure, isRunInProgress, workflowStatusLabel, workflowStatusTone } from './deployment-status-model';
import { StatusChip, StatusIcon } from './deployment-status-ui';

export function WorkflowRunList({ environments, onOpenRun, runs }: {
  environments: DeployedEnvironmentStatus[];
  onOpenRun(runId: number): void;
  runs: GitHubWorkflowRunSummary[];
}) {
  if (runs.length === 0) return null;
  return <div className="divide-y divide-neutral-800/70 border-y border-neutral-800/70">
    {runs.map((run) => <WorkflowRunRow key={run.id} environments={environments} onOpenRun={onOpenRun} run={run} />)}
  </div>;
}

function WorkflowRunRow({ environments, onOpenRun, run }: { environments: DeployedEnvironmentStatus[]; onOpenRun(runId: number): void; run: GitHubWorkflowRunSummary }) {
  const tone = workflowStatusTone(run.status, run.conclusion);
  const current = isCurrentDeploymentRun(run, environments);
  const historicalFailure = isHistoricalFailure(run, environments);
  const superseded = !current && run.status === 'completed' && run.conclusion === 'success';
  return <div className="group grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 px-1 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
    <StatusIcon active={isRunInProgress(run)} tone={tone} />
    <button type="button" onClick={() => onOpenRun(run.id)} className="min-w-0 text-left">
      <span className="block truncate text-sm font-medium text-neutral-100 group-hover:text-white">{run.displayTitle || run.name || `Run #${run.runNumber ?? run.id}`}</span>
      <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
        {run.name && run.name !== run.displayTitle ? <span>{run.name}</span> : null}
        {run.event ? <span>trigger {run.event}</span> : null}
        {run.branch ? <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{run.branch}</span> : null}
        {run.headSha ? <span className="inline-flex max-w-full items-center gap-1 font-mono" title={run.headSha}><GitCommitHorizontal className="size-3" />{run.headSha}</span> : null}
        {run.actor ? <span>by {run.actor}</span> : null}
        {run.attempt ? <span>attempt {run.attempt}</span> : null}
        {run.runStartedAt ? <span title={new Date(run.runStartedAt).toLocaleString()}>started {new Date(run.runStartedAt).toLocaleString()}</span> : null}
        {run.updatedAt ? <span title={new Date(run.updatedAt).toLocaleString()}>ended {new Date(run.updatedAt).toLocaleString()}</span> : null}
      </span>
    </button>
    <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-auto sm:justify-end">
      {current ? <StatusChip tone="success">deployed now</StatusChip> : historicalFailure ? <StatusChip tone="muted">historical failure</StatusChip> : superseded ? <StatusChip tone="muted">superseded</StatusChip> : null}
      <StatusChip tone={tone}>{workflowStatusLabel(run.status, run.conclusion)}</StatusChip>
      {run.runStartedAt && run.updatedAt ? <Text className="hidden text-xs text-neutral-500 md:block">{formatDuration(Date.parse(run.updatedAt) - Date.parse(run.runStartedAt))}</Text> : null}
      {run.url ? <Button aria-label="Open run on GitHub" isIconOnly size="sm" variant="ghost" onPress={() => window.open(run.url, '_blank', 'noopener,noreferrer')}><ExternalLink className="size-3.5" /></Button> : null}
    </div>
  </div>;
}
