import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, RefreshCw, Rocket, Workflow } from 'lucide-react';
import { Accordion, Button, Surface, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  DeployedEnvironmentStatusResult,
  GitHubCatalogStatus,
  GitHubPipelineStatusResult,
  GitHubWorkflowJob,
  GitHubWorkflowRunDetailResult,
  GitHubWorkflowRunSummary
} from '@/shared/project-space-api';
import { DeploymentEnvironmentList, EmptyLine } from './deployment-environment-list';
import {
  deploymentRuns,
  formatDuration,
  isHistoricalFailure,
  isRunInProgress,
  pipelineStateMessage,
  workflowStatusLabel,
  workflowStatusTone
} from './deployment-status-model';
import { StatusChip, StatusIcon } from './deployment-status-ui';
import { PullRequestPreviewsSection } from './pull-request-previews-section';
import { WorkflowRunList } from './workflow-run-list';
import { useDeploymentOverview } from '../hooks/use-deployment-overview';
import { usePullRequestPreviewStatus } from '../hooks/use-pull-request-preview-status';

interface ProjectDeploymentsPanelProps {
  loadedCommitShas?: ReadonlySet<string>;
  onCloseWorkflowRun?(): void;
  onOpenWorkflowRun?(runId: number): void;
  projectName: string;
  repository?: { fullName: string; url?: string };
  selectedWorkflowRunId?: number;
  targetPath?: string;
}

export function ProjectDeploymentsPanel(props: ProjectDeploymentsPanelProps) {
  if (props.selectedWorkflowRunId && props.repository) {
    return <WorkflowRunDetail
      onBack={props.onCloseWorkflowRun ?? (() => undefined)}
      repositoryFullName={props.repository.fullName}
      runId={props.selectedWorkflowRunId}
    />;
  }
  return <DeploymentsOverview {...props} />;
}

function DeploymentsOverview({ loadedCommitShas, onOpenWorkflowRun, repository }: ProjectDeploymentsPanelProps) {
  const repositoryFullName = repository?.fullName;
  const data = useDeploymentOverview(repositoryFullName, true);
  const previews = usePullRequestPreviewStatus({
    enabled: Boolean(repositoryFullName),
    repositoryFullName
  });
  const {
    environments,
    hasLoaded,
    historyCommitShas,
    isLoadingMore,
    isRefreshing,
    loadMore,
    pipeline,
    refresh,
    requestFailed,
    runs
  } = data;
  const currentRuns = runs.filter((run) => !isHistoricalFailure(run, environments?.environments ?? []));
  const historicalFailures = runs.filter((run) => isHistoricalFailure(run, environments?.environments ?? []));
  const checkedAt = environments?.checkedAt ?? pipeline?.checkedAt;
  const stale = checkedAt ? Date.now() - Date.parse(checkedAt) > 120_000 : false;

  if (!repositoryFullName) return <PageState title="Deployments unavailable">No GitHub repository is linked to this project.</PageState>;
  if (!hasLoaded) return <PageState active title="Loading deployments">Checking deployed environments and deployment workflows…</PageState>;

  return <div className="grid gap-6">
    <header className="flex min-w-0 flex-wrap items-center gap-2">
      <Rocket className="size-4 text-neutral-400" />
      <Text className="text-sm font-semibold text-neutral-100">Deployments</Text>
      <Text className="text-xs text-neutral-500">read-only</Text>
      {checkedAt ? <Text className="text-xs text-neutral-500" title={new Date(checkedAt).toLocaleString()}>{stale ? 'stale data' : `checked ${new Date(checkedAt).toLocaleTimeString()}`}</Text> : null}
      <Button aria-label="Refresh deployments" className="ml-auto" isDisabled={isRefreshing} size="sm" variant="ghost" onPress={() => void refresh()}>
        <RefreshCw className={isRefreshing ? 'size-4 animate-spin' : 'size-4'} />Refresh
      </Button>
    </header>

    {requestFailed ? <InlineNotice tone="warning">Some deployment information could not be refreshed. Available verified data is shown below.</InlineNotice> : null}

    <section className="grid gap-2">
      <SectionTitle icon={<Rocket className="size-4" />} title="Environments" />
      {environments?.status === 'available'
        ? <DeploymentEnvironmentList environments={environments.environments} loadedCommitShas={loadedCommitShas ?? historyCommitShas} runs={pipeline?.runs ?? []} />
        : <EnvironmentState status={environments?.status} />}
    </section>

    <section className="grid gap-2">
      <SectionTitle icon={<GitPullRequest className="size-4" />} title="Pull request previews" />
      <PullRequestPreviewsSection inventory={previews.inventory} repositoryFullName={repositoryFullName} />
    </section>

    <section className="grid gap-2">
      <SectionTitle icon={<Workflow className="size-4" />} title="Deployment pipeline" />
      {pipeline?.status !== 'connected'
        ? <PipelineState message={pipeline?.message} status={pipeline?.status} />
        : runs.length === 0
          ? <EmptyLine>No deployment workflow runs were found. Release, pull request, and unrelated CI workflows are intentionally excluded.</EmptyLine>
          : <>
              <WorkflowRunList environments={environments?.environments ?? []} onOpenRun={onOpenWorkflowRun ?? (() => undefined)} runs={currentRuns} />
              {historicalFailures.length > 0 ? <div className="mt-4 grid gap-2">
                <Text className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-600">Historical failures</Text>
                <Text className="text-xs text-neutral-500">These attempts are not the currently verified deployed build.</Text>
                <WorkflowRunList environments={environments?.environments ?? []} onOpenRun={onOpenWorkflowRun ?? (() => undefined)} runs={historicalFailures} />
              </div> : null}
              {pipeline.pagination?.hasNext ? <Button className="mt-3 w-fit" isDisabled={isLoadingMore} size="sm" variant="ghost" onPress={() => void loadMore()}>
                {isLoadingMore ? <RefreshCw className="size-4 animate-spin" /> : null}Load older runs
              </Button> : null}
            </>}
    </section>
  </div>;
}

function EnvironmentState({ status }: { status?: DeployedEnvironmentStatusResult['status'] }) {
  if (status === 'unauthorized') return <InlineNotice tone="danger">This repository is not authorized to read the deployed-environment status.</InlineNotice>;
  if (status === 'unavailable') return <InlineNotice tone="warning">Deployed-environment verification is temporarily unavailable.</InlineNotice>;
  return <InlineNotice tone="muted">Deployed-environment status did not load.</InlineNotice>;
}

function PipelineState({ message, status }: { message?: string; status?: GitHubCatalogStatus }) {
  return <InlineNotice tone={status === 'rate-limited' ? 'warning' : status === 'error' ? 'danger' : 'muted'}>
    {status ? pipelineStateMessage(status, message) : 'Deployment pipeline status did not load.'}
  </InlineNotice>;
}

export function WorkflowRunDetail({ onBack, repositoryFullName, runId }: { onBack(): void; repositoryFullName: string; runId: number }) {
  const [result, setResult] = useState<GitHubWorkflowRunDetailResult>();
  const [detailEnvironments, setDetailEnvironments] = useState<DeployedEnvironmentStatusResult>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const [detail, environmentStatus] = await Promise.all([
        projectSpaceClient.getGitHubWorkflowRunDetail(repositoryFullName, runId),
        projectSpaceClient.getDeployedEnvironmentStatus(repositoryFullName)
      ]);
      setResult(detail);
      setDetailEnvironments(environmentStatus);
    }
    catch { setFailed(true); }
    finally { setLoading(false); }
  }, [repositoryFullName, runId]);
  useEffect(() => { void load(); }, [load]);

  if (loading && !result) return <PageState active title="Loading workflow run">Loading jobs and steps…</PageState>;
  if (failed && !result) return <DetailError onBack={onBack} onRetry={load}>Workflow run details could not be loaded.</DetailError>;
  if (!result || result.status !== 'connected' || !result.run) return <DetailError onBack={onBack} onRetry={load}>{result?.status ? pipelineStateMessage(result.status, result.message) : 'Workflow run details are unavailable.'}</DetailError>;

  const run = result.run;
  const correlatedEnvironments = run.headSha
    ? (detailEnvironments?.environments ?? []).filter((environment) => environment.deployedSha === run.headSha)
    : [];
  const tone = workflowStatusTone(run.status, run.conclusion);
  return <div className="grid gap-5">
    <header className="grid gap-3 border-b border-neutral-800/70 pb-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button aria-label="Back to deployments" isIconOnly size="sm" variant="ghost" onPress={onBack}><ArrowLeft className="size-4" /></Button>
        <StatusIcon active={isRunInProgress(run)} tone={tone} />
        <Text className="min-w-0 truncate text-sm font-semibold text-neutral-100">{run.displayTitle || run.name || `Run #${run.runNumber ?? run.id}`}</Text>
        <StatusChip tone={tone}>{workflowStatusLabel(run.status, run.conclusion)}</StatusChip>
        <Button aria-label="Refresh workflow run" className="ml-auto" isDisabled={loading} isIconOnly size="sm" variant="ghost" onPress={() => void load()}><RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} /></Button>
      </div>
      <RunMetadata run={run} />
      {correlatedEnvironments.length ? <Text className="pl-10 text-xs text-emerald-300">Currently deployed to {correlatedEnvironments.map((environment) => environment.displayName).join(', ')}</Text> : null}
      {result.partial ? <InlineNotice tone="warning">GitHub returned partial job or step information. The available read-only details are shown.</InlineNotice> : null}
    </header>
    <section className="grid gap-2">
      <SectionTitle icon={<Workflow className="size-4" />} title={`Jobs (${result.jobs.length})`} />
      {result.jobs.length ? <JobList jobs={result.jobs} /> : <EmptyLine>No jobs were returned for this workflow run.</EmptyLine>}
    </section>
  </div>;
}

function RunMetadata({ run }: { run: GitHubWorkflowRunSummary }) {
  return <div className="grid min-w-0 gap-x-4 gap-y-2 pl-10 text-xs text-neutral-500 sm:flex sm:flex-wrap sm:items-center">
    {run.runNumber ? <span>run #{run.runNumber}</span> : null}
    {run.event ? <span>trigger {run.event}</span> : null}
    {run.branch ? <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{run.branch}</span> : null}
    {run.headSha ? <span className="inline-flex min-w-0 max-w-full items-start gap-1 break-all font-mono" title={run.headSha}><GitCommitHorizontal className="mt-0.5 size-3 shrink-0" />{run.headSha}</span> : null}
    {run.actor ? <span>by {run.actor}</span> : null}
    {run.attempt ? <span>attempt {run.attempt}</span> : null}
    {run.runStartedAt ? <span title={new Date(run.runStartedAt).toLocaleString()}>started {new Date(run.runStartedAt).toLocaleString()}</span> : null}
    {run.updatedAt ? <span title={new Date(run.updatedAt).toLocaleString()}>updated {new Date(run.updatedAt).toLocaleString()}</span> : null}
    {run.runStartedAt && run.updatedAt ? <span>{formatDuration(Date.parse(run.updatedAt) - Date.parse(run.runStartedAt))}</span> : null}
    {run.url ? <a href={run.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-neutral-300 hover:text-white">Open on GitHub<ExternalLink className="size-3" /></a> : null}
  </div>;
}

function JobList({ jobs }: { jobs: GitHubWorkflowJob[] }) {
  const [expanded, setExpanded] = useState<Set<React.Key>>(() => new Set(jobs.filter((job) => job.status !== 'completed' || job.conclusion === 'failure').map((job) => String(job.id))));
  return <Accordion allowsMultipleExpanded expandedKeys={expanded} onExpandedChange={setExpanded} className="divide-y divide-neutral-800/70 border-y border-neutral-800/70">
    {jobs.map((job) => {
      const tone = workflowStatusTone(job.status, job.conclusion);
      return <Accordion.Item id={String(job.id)} key={job.id}>
        <Accordion.Heading><Accordion.Trigger className="px-1 py-3 text-left" title={[job.startedAt && `Started ${new Date(job.startedAt).toLocaleString()}`, job.completedAt && `Completed ${new Date(job.completedAt).toLocaleString()}`].filter(Boolean).join(' · ')}>
          <span className="flex min-w-0 items-center gap-3"><StatusIcon active={job.status !== 'completed' && job.status !== 'unknown'} tone={tone} /><span className="truncate text-sm font-medium text-neutral-100">{job.name}</span></span>
          <span className="ml-auto flex shrink-0 items-center gap-2"><span className="hidden text-xs text-neutral-500 sm:block">{formatDuration(job.durationMs)}</span><StatusChip tone={tone}>{workflowStatusLabel(job.status, job.conclusion)}</StatusChip><Accordion.Indicator className="text-neutral-500" /></span>
        </Accordion.Trigger></Accordion.Heading>
        <Accordion.Panel><Accordion.Body className="pb-3 pl-7">
          {(job.startedAt || job.completedAt) ? <Text className="mb-2 block text-xs text-neutral-600">
            {[job.startedAt && `Started ${new Date(job.startedAt).toLocaleString()}`, job.completedAt && `Completed ${new Date(job.completedAt).toLocaleString()}`].filter(Boolean).join(' · ')}
          </Text> : null}
          {job.steps.length ? <div className="divide-y divide-neutral-800/50 border-l border-neutral-800/70">
            {job.steps.map((step) => {
              const stepTone = workflowStatusTone(step.status, step.conclusion);
              return <div key={`${job.id}-${step.number}`} title={[step.startedAt && `Started ${new Date(step.startedAt).toLocaleString()}`, step.completedAt && `Completed ${new Date(step.completedAt).toLocaleString()}`].filter(Boolean).join(' · ')} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2 pl-3 pr-1">
                <StatusIcon active={step.status !== 'completed' && step.status !== 'unknown'} tone={stepTone} />
                <Text className="truncate text-xs text-neutral-300">{step.number}. {step.name}</Text>
                <span className="flex items-center gap-2"><span className="hidden text-xs text-neutral-600 lg:block">{step.startedAt ? new Date(step.startedAt).toLocaleTimeString() : ''}{step.completedAt ? `–${new Date(step.completedAt).toLocaleTimeString()}` : ''}</span><span className="hidden text-xs text-neutral-600 sm:block">{formatDuration(step.durationMs)}</span><StatusChip tone={stepTone}>{workflowStatusLabel(step.status, step.conclusion)}</StatusChip></span>
              </div>;
            })}
          </div> : <Text className="text-xs text-neutral-500">No step details were returned for this job.</Text>}
        </Accordion.Body></Accordion.Panel>
      </Accordion.Item>;
    })}
  </Accordion>;
}

function DetailError({ children, onBack, onRetry }: { children: React.ReactNode; onBack(): void; onRetry(): void }) {
  return <div className="grid gap-4"><Button className="w-fit" size="sm" variant="ghost" onPress={onBack}><ArrowLeft className="size-4" />Deployments</Button><InlineNotice tone="warning">{children}</InlineNotice><Button className="w-fit" size="sm" variant="outline" onPress={onRetry}>Try again</Button></div>;
}

function PageState({ active = false, children, title }: { active?: boolean; children: React.ReactNode; title: string }) {
  return <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"><div className="flex items-center gap-3"><StatusIcon active={active} tone="muted" /><div><Text className="block text-sm font-semibold text-neutral-200">{title}</Text><Text className="mt-1 block text-sm text-neutral-500">{children}</Text></div></div></Surface>;
}

function InlineNotice({ children, tone }: { children: React.ReactNode; tone: 'danger' | 'muted' | 'warning' }) {
  const styles = tone === 'danger' ? 'border-rose-400/25 text-rose-200' : tone === 'warning' ? 'border-amber-400/25 text-amber-200' : 'border-neutral-800 text-neutral-400';
  return <div className={`border-y px-1 py-3 text-sm ${styles}`}>{children}</div>;
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return <div className="flex items-center gap-2 text-neutral-500">{icon}<Text className="text-[11px] font-semibold uppercase tracking-[0.14em]">{title}</Text></div>;
}
