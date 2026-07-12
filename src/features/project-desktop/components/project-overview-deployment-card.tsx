import { Radio, RefreshCw, Rocket } from 'lucide-react';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type {
  DeployedEnvironmentStatus,
  GitHubWorkflowRunSummary
} from '@/shared/project-space-api';
import { useDeploymentOverview } from '../hooks/use-deployment-overview';
import {
  deploymentRunContext,
  formatDuration,
  sortEnvironments,
  workflowStatusLabel,
  workflowStatusTone
} from './deployment-status-model';
import { StatusChip, StatusIcon } from './deployment-status-ui';
import { PublicDeploymentLink } from './public-deployment-link';

function EnvironmentRow({ environment }: { environment: DeployedEnvironmentStatus }) {
  return (
    <div className="grid min-w-0 gap-1 py-1.5 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-1.5">
        <Radio className={environment.verification === 'healthy' ? 'size-3 text-emerald-400' : 'size-3 text-neutral-600'} />
        <Text className="truncate text-xs font-medium text-neutral-200">{environment.displayName}</Text>
      </div>
      {environment.liveUrl ? (
        <PublicDeploymentLink environmentName={environment.displayName} href={environment.liveUrl} />
      ) : (
        <Text className="text-xs text-neutral-600">
          {environment.liveUrlState === 'withheld' ? 'Private URL withheld' : 'No public URL'}
        </Text>
      )}
      <span className="font-mono text-[10px] text-neutral-500" title={environment.deployedSha}>
        {environment.deployedSha?.slice(0, 7) ?? 'SHA unavailable'}
      </span>
    </div>
  );
}

const contextLabels = {
  active: 'Active',
  current: 'Live',
  failed: 'Failed',
  other: 'History',
  superseded: 'Superseded'
} as const;

function RecentRunRow({ environments, run }: {
  environments: DeployedEnvironmentStatus[];
  run: GitHubWorkflowRunSummary;
}) {
  const context = deploymentRunContext(run, environments);
  const tone = context === 'current'
    ? 'success'
    : context === 'failed'
      ? 'danger'
      : context === 'active'
        ? 'warning'
        : 'muted';
  const duration = run.runStartedAt && run.updatedAt
    ? formatDuration(Date.parse(run.updatedAt) - Date.parse(run.runStartedAt))
    : '';
  return (
    <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 py-2">
      <StatusIcon active={context === 'active'} tone={workflowStatusTone(run.status, run.conclusion)} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-mono text-[10px] text-neutral-400" title={run.headSha}>
            {run.headSha?.slice(0, 7) ?? `#${run.runNumber ?? run.id}`}
          </span>
          {run.runStartedAt ? (
            <span className="text-[10px] text-neutral-600" title={new Date(run.runStartedAt).toLocaleString()}>
              {new Date(run.runStartedAt).toLocaleString()}
            </span>
          ) : null}
          {duration ? <span className="text-[10px] text-neutral-600">{duration}</span> : null}
        </div>
        <Text className="block truncate text-[11px] text-neutral-500" title={run.displayTitle || run.name}>
          {run.displayTitle || run.name || workflowStatusLabel(run.status, run.conclusion)}
        </Text>
      </div>
      <StatusChip tone={tone}>{contextLabels[context]}</StatusChip>
    </div>
  );
}

export function ProjectOverviewDeploymentCard({
  onOpenDeployments,
  repositoryFullName
}: {
  onOpenDeployments(): void;
  repositoryFullName?: string;
}) {
  const data = useDeploymentOverview(repositoryFullName);
  const environments = data.environments?.environments ?? [];
  const recentRuns = data.runs.slice(0, 3);
  const stale = data.checkedAt ? Date.now() - Date.parse(data.checkedAt) > 120_000 : false;

  return (
    <Surface
      variant="tertiary"
      className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
    >
      <div className="mb-3 flex min-w-0 items-center gap-2">
        <Rocket className="size-4 shrink-0 text-neutral-400" />
        <Text className="text-sm font-semibold text-neutral-100">Deployment</Text>
        {stale ? <span className="text-[10px] font-medium text-amber-300">stale</span> : null}
        <Button className="ml-auto h-7 px-2 text-xs" size="sm" variant="ghost" onPress={onOpenDeployments}>
          View all
        </Button>
        <Button
          aria-label="Refresh deployment overview"
          isDisabled={data.isRefreshing || !repositoryFullName}
          isIconOnly
          size="sm"
          variant="ghost"
          onPress={() => void data.refresh()}
        >
          <RefreshCw className={data.isRefreshing ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
      </div>

      {!repositoryFullName ? (
        <Text className="text-xs text-neutral-500">No GitHub repository is linked.</Text>
      ) : !data.hasLoaded ? (
        <Text className="text-xs text-neutral-500">Loading deployment status…</Text>
      ) : (
        <>
          <Text className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
            Environments
          </Text>
          <div className="mt-1 divide-y divide-neutral-800/60">
            {environments.length ? sortEnvironments(environments).map((environment) => (
              <EnvironmentRow environment={environment} key={environment.id} />
            )) : (
              <Text className="block py-2 text-xs text-neutral-500">
                {data.environments?.status === 'unauthorized'
                  ? 'Deployment status is not authorized.'
                  : 'No deployed environments are available.'}
              </Text>
            )}
          </div>

          <div className="mt-2 border-t border-neutral-800/70 pt-3">
            <Text className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
              Recent deployments
            </Text>
            <div className="mt-1 divide-y divide-neutral-800/60">
              {recentRuns.length ? recentRuns.map((run) => (
                <RecentRunRow environments={environments} key={run.id} run={run} />
              )) : (
                <Text className="block py-2 text-xs text-neutral-500">
                  {data.requestFailed ? 'Recent pipeline runs are temporarily unavailable.' : 'No deployment runs found.'}
                </Text>
              )}
            </div>
          </div>
        </>
      )}
    </Surface>
  );
}
