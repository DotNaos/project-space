import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, Inbox } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ConnectorOverviewResult,
  GitHubBranchRecord,
  GitHubCatalogRepository,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  GitHubRepositoryDetailsResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { GitHubMark } from './github-mark';
import { IssueActionPanel } from './issue-action-panel';
import { IssueBody } from './issue-body';
import { IssueDetailList } from './issue-detail-list';
import { IssueIndexPanel } from './issue-index-panel';
import {
  loadIssueColumnOrder,
  loadIssueViewMode,
  orderedIssueColumns,
  saveIssueViewMode,
  type IssueViewMode
} from './issue-board-model';
import { repositoryDetailsFallback } from './project-main-model';
import { useRoadmap } from '../../roadmap/use-roadmap';

function useRepositoryDetails(repository?: GitHubCatalogRepository) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const repositoryFullName = repository?.fullName;

  useEffect(() => {
    if (!repositoryFullName) {
      setDetails(undefined);
      setError('');
      setIsLoading(false);
      return;
    }

    let canceled = false;
    setDetails(undefined);
    setError('');
    setIsLoading(true);
    projectSpaceClient
      .getGitHubRepositoryDetails(repositoryFullName)
      .then((nextDetails) => {
        if (!canceled) setDetails(nextDetails);
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not load repository details.'
          );
        }
      })
      .finally(() => {
        if (!canceled) setIsLoading(false);
      });

    return () => {
      canceled = true;
    };
  }, [repositoryFullName, retryGeneration]);

  const retry = useCallback(() => {
    setRetryGeneration((generation) => generation + 1);
  }, []);

  return { details, error, isLoading, retry, setDetails };
}

export function ProjectIssueDetailPanel({
  connectorOverview,
  issueNumber,
  onBack,
  onOpenIssue,
  project,
  projects,
  repository,
  targetPath
}: {
  connectorOverview: ConnectorOverviewResult;
  issueNumber?: number;
  onBack(): void;
  onOpenIssue(issueNumber: number): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  repository?: GitHubCatalogRepository;
  targetPath: string;
}) {
  const { details, error, isLoading, retry, setDetails } = useRepositoryDetails(repository);
  const roadmap = useRoadmap(repository?.fullName);
  const [viewMode, setViewMode] = useState<IssueViewMode>(() => loadIssueViewMode());
  const [query, setQuery] = useState('');
  const [activeLabels, setActiveLabels] = useState<ReadonlySet<string>>(() => new Set());
  const safeDetails = details ?? repositoryDetailsFallback(repository ? 'connected' : 'error');
  const evidenceState = !repository
    ? 'blocked'
    : isLoading && !details
      ? 'loading'
      : details?.status === 'connected'
        ? 'ready'
        : 'blocked';
  const issue = safeDetails.issues.find((entry) => entry.number === issueNumber);
  const emptyMessage =
    error ||
    safeDetails.message ||
    (!repository ? 'No GitHub repository is linked to this project.' : 'No issues.');

  useEffect(() => {
    setQuery('');
    setActiveLabels(new Set());
  }, [repository?.fullName]);

  const updateDetails = <T,>(
    list: keyof Pick<GitHubRepositoryDetailsResult, 'issues' | 'branches' | 'pullRequests'>,
    record: T,
    matches: (entry: T) => boolean
  ) => {
    setDetails((previous) => {
      const base = previous ?? safeDetails;
      const current = base[list] as T[];
      const next = current.some(matches)
        ? current.map((entry) => (matches(entry) ? record : entry))
        : [record, ...current];
      return { ...base, [list]: next, checkedAt: new Date().toISOString() };
    });
  };

  const upsertIssue = (record: GitHubIssueRecord) =>
    updateDetails('issues', record, (entry) => entry.number === record.number);
  const upsertBranch = (record: GitHubBranchRecord) =>
    updateDetails('branches', record, (entry) => entry.name === record.name);
  const upsertPullRequest = (record: GitHubPullRequestRecord) =>
    updateDetails('pullRequests', record, (entry) => entry.number === record.number);

  return (
    <Surface variant="transparent" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {issueNumber ? (
        <div className="mb-4 flex min-w-0 shrink-0 items-center justify-between gap-3">
          <Button size="sm" variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" /> Issues
          </Button>
          {issue?.url ? (
            <a href={issue.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200">
              <GitHubMark className="size-3.5" /> Open on GitHub <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}

      {issue ? (
        <IssueDetailWorkbench
          branches={safeDetails.branches}
          connectorOverview={connectorOverview}
          issue={issue}
          issues={safeDetails.issues}
          onBranchCreated={upsertBranch}
          onIssueUpdated={upsertIssue}
          onOpenIssue={onOpenIssue}
          onPullRequestCreated={upsertPullRequest}
          project={project}
          projects={projects}
          pullRequests={safeDetails.pullRequests}
          repoFullName={repository?.fullName}
          repoUrl={repository?.url}
          targetPath={targetPath}
        />
      ) : issueNumber && isLoading && !details && !error ? (
        <IssueBoardSkeleton viewMode="list" />
      ) : issueNumber ? (
        <IssueEmptyState
          message={details?.status === 'connected'
            ? 'Issue was not found in the loaded issues.'
            : emptyMessage}
          onRetry={repository && evidenceState === 'blocked' ? retry : undefined}
        />
      ) : (
        <IssueIndexPanel
          activeLabels={activeLabels}
          branches={safeDetails.branches}
          emptyMessage={emptyMessage}
          evidenceState={evidenceState}
          isLoading={isLoading}
          issues={safeDetails.issues}
          onActiveLabelsChange={setActiveLabels}
          onBranchCreated={upsertBranch}
          onIssueCreated={upsertIssue}
          onOpenIssue={onOpenIssue}
          onQueryChange={setQuery}
          onRetry={repository && evidenceState === 'blocked' ? retry : undefined}
          onViewModeChange={(nextMode) => {
            setViewMode(nextMode);
            saveIssueViewMode(nextMode);
          }}
          projectId={project.id}
          pullRequests={safeDetails.pullRequests}
          query={query}
          roadmap={roadmap}
          repository={repository}
          viewMode={viewMode}
        />
      )}
    </Surface>
  );
}

function IssueBoardSkeleton({ viewMode }: { viewMode: IssueViewMode }) {
  if (viewMode === 'list') {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-2">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex animate-pulse items-center gap-3 px-2 py-3">
            <span className="size-1.5 rounded-full bg-neutral-800" />
            <span className="h-3 w-10 rounded bg-neutral-800/80" />
            <span className="h-3 rounded bg-neutral-800/60" style={{ width: `${34 + ((index * 13) % 40)}%` }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden pb-2">
      {orderedIssueColumns(loadIssueColumnOrder()).map((column) => (
        <div key={column.id} className="flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40">
          <div className="flex items-center gap-2 border-b border-neutral-800/60 px-3 py-2.5">
            <span className={cn('size-1.5 rounded-full opacity-60', column.dotClass)} />
            <Text className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-600">{column.label}</Text>
          </div>
        </div>
      ))}
    </div>
  );
}

function IssueEmptyState({ message, onRetry }: { message: string; onRetry?(): void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-neutral-800/80 p-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/60">
        <Inbox className="size-5 text-neutral-500" />
      </span>
      <Text className="max-w-sm text-sm text-neutral-400">{message}</Text>
      {onRetry ? (
        <Button size="sm" variant="ghost" onPress={onRetry}>Retry</Button>
      ) : null}
    </div>
  );
}

function IssueDetailWorkbench({ branches, connectorOverview, issue, issues, onBranchCreated, onIssueUpdated, onOpenIssue, onPullRequestCreated, project, projects, pullRequests, repoFullName, repoUrl, targetPath }: {
  branches: GitHubBranchRecord[];
  connectorOverview: ConnectorOverviewResult;
  issue: GitHubIssueRecord;
  issues: GitHubIssueRecord[];
  onBranchCreated(branch: GitHubBranchRecord): void;
  onIssueUpdated(issue: GitHubIssueRecord): void;
  onOpenIssue(issueNumber: number): void;
  onPullRequestCreated(pullRequest: GitHubPullRequestRecord): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
  repoUrl?: string;
  targetPath: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 auto-rows-max content-start gap-4 overflow-y-auto lg:auto-rows-auto lg:grid-cols-[minmax(13rem,0.55fr)_minmax(0,1.2fr)_minmax(14rem,0.6fr)] lg:content-stretch lg:overflow-hidden">
      <IssueDetailList className="hidden lg:flex" issues={issues} onOpenIssue={onOpenIssue} repoFullName={repoFullName} selectedIssueNumber={issue.number} />
      <IssueBody issue={issue} onIssueUpdated={onIssueUpdated} repoFullName={repoFullName} />
      <IssueActionPanel branches={branches} connectorOverview={connectorOverview} issue={issue} onBranchCreated={onBranchCreated} onIssueUpdated={onIssueUpdated} onPullRequestCreated={onPullRequestCreated} project={project} projects={projects} pullRequests={pullRequests} repoFullName={repoFullName} repoUrl={repoUrl} targetPath={targetPath} />
    </div>
  );
}
