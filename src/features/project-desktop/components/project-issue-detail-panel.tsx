import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns3,
  ExternalLink,
  Inbox,
  List,
  ListChecks,
  Plus,
  SlidersHorizontal,
  Tags,
  X
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Button,
  Dropdown,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  SearchField,
  SearchFieldClearButton,
  SearchFieldGroup,
  SearchFieldInput,
  SearchFieldSearchIcon,
  Surface,
  Text,
  ToggleButton,
  ToggleButtonGroup
} from '@/app/dotnaos-ui';
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
import { IssueActionPanel } from './issue-action-panel';
import { GitHubMark } from './github-mark';
import {
  filterIssues,
  groupIssuesByColumn,
  issueUpdatedAtLabel,
  labelChipStyle,
  loadHiddenIssueColumns,
  loadIssueColumnOverrides,
  loadIssueColumnOrder,
  loadIssueViewMode,
  orderedIssueColumns,
  resolveIssueColumn,
  saveHiddenIssueColumns,
  saveIssueColumnOverrides,
  saveIssueColumnOrder,
  saveIssueViewMode,
  topIssueLabels,
  type IssueColumnId,
  type IssueColumnOverrides,
  type IssueViewMode
} from './issue-board-model';
import { IssueBody, IssueEditor, type IssueFormValues } from './issue-body';
import { IssueDetailList } from './issue-detail-list';
import { IssueKanbanBoard } from './issue-kanban-board';
import { IssueListView } from './issue-list-view';
import { repositoryDetailsFallback } from './project-main-model';

function useRepositoryDetails(repository?: GitHubCatalogRepository) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!repository) {
      setDetails(undefined);
      setError('');
      setIsLoading(false);
      return;
    }

    let canceled = false;

    setError('');
    setIsLoading(true);
    projectSpaceClient
      .getGitHubRepositoryDetails(repository.fullName)
      .then((nextDetails) => {
        if (!canceled) {
          setDetails(nextDetails);
        }
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
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [repository]);

  return { details, error, isLoading, setDetails };
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
  const { details, error, isLoading, setDetails } = useRepositoryDetails(repository);
  const [viewMode, setViewMode] = useState<IssueViewMode>(() => loadIssueViewMode());
  const [query, setQuery] = useState('');
  const [activeLabels, setActiveLabels] = useState<ReadonlySet<string>>(() => new Set());

  const safeDetails = details ?? repositoryDetailsFallback(repository ? 'connected' : 'error');
  const issues = safeDetails.issues;
  const issue = issues.find((entry) => entry.number === issueNumber);
  const emptyMessage =
    error ||
    safeDetails.message ||
    (!repository ? 'No GitHub repository is linked to this project.' : 'No issues.');

  const upsertIssue = (nextIssue: GitHubIssueRecord) => {
    setDetails((previous) => {
      const base = previous ?? safeDetails;
      const exists = base.issues.some((entry) => entry.number === nextIssue.number);
      const nextIssues = exists
        ? base.issues.map((entry) => (entry.number === nextIssue.number ? nextIssue : entry))
        : [nextIssue, ...base.issues];

      return {
        ...base,
        checkedAt: new Date().toISOString(),
        issues: nextIssues
      };
    });
  };

  const upsertBranch = (nextBranch: GitHubBranchRecord) => {
    setDetails((previous) => {
      const base = previous ?? safeDetails;
      const exists = base.branches.some((entry) => entry.name === nextBranch.name);
      const nextBranches = exists
        ? base.branches.map((entry) => (entry.name === nextBranch.name ? nextBranch : entry))
        : [nextBranch, ...base.branches];

      return {
        ...base,
        branches: nextBranches,
        checkedAt: new Date().toISOString()
      };
    });
  };

  const upsertPullRequest = (nextPullRequest: GitHubPullRequestRecord) => {
    setDetails((previous) => {
      const base = previous ?? safeDetails;
      const exists = base.pullRequests.some((entry) => entry.number === nextPullRequest.number);
      const nextPullRequests = exists
        ? base.pullRequests.map((entry) =>
            entry.number === nextPullRequest.number ? nextPullRequest : entry
          )
        : [nextPullRequest, ...base.pullRequests];

      return {
        ...base,
        checkedAt: new Date().toISOString(),
        pullRequests: nextPullRequests
      };
    });
  };

  return (
    <Surface
      variant="transparent"
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {issueNumber ? (
        <div className="mb-4 flex min-w-0 shrink-0 items-center justify-between gap-3">
          <Button size="sm" variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" />
            Issues
          </Button>
          {issue?.url ? (
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-200"
            >
              <GitHubMark className="size-3.5" />
              Open on GitHub
              <ExternalLink className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}

      {issue ? (
        <IssueDetailWorkbench
          branches={safeDetails.branches}
          connectorOverview={connectorOverview}
          issue={issue}
          issues={issues}
          onBranchCreated={upsertBranch}
          onOpenIssue={onOpenIssue}
          onIssueUpdated={upsertIssue}
          onPullRequestCreated={upsertPullRequest}
          project={project}
          projects={projects}
          repoFullName={repository?.fullName}
          repoUrl={repository?.url}
          targetPath={targetPath}
        />
      ) : issueNumber ? (
        <IssueEmptyState
          message={details ? 'Issue was not found in the loaded issues.' : emptyMessage}
        />
      ) : (
        <IssueIndex
          activeLabels={activeLabels}
          emptyMessage={emptyMessage}
          isLoading={isLoading}
          issues={issues}
          pullRequests={safeDetails.pullRequests}
          onActiveLabelsChange={setActiveLabels}
          branches={safeDetails.branches}
          onIssueCreated={upsertIssue}
          onBranchCreated={upsertBranch}
          onOpenIssue={onOpenIssue}
          onQueryChange={setQuery}
          onViewModeChange={(nextMode) => {
            setViewMode(nextMode);
            saveIssueViewMode(nextMode);
          }}
          query={query}
          repository={repository}
          viewMode={viewMode}
        />
      )}
    </Surface>
  );
}

function IssueIndex({
  activeLabels,
  emptyMessage,
  isLoading,
  branches,
  issues,
  pullRequests,
  onActiveLabelsChange,
  onBranchCreated,
  onIssueCreated,
  onOpenIssue,
  onQueryChange,
  onViewModeChange,
  query,
  repository,
  viewMode
}: {
  activeLabels: ReadonlySet<string>;
  emptyMessage: string;
  isLoading: boolean;
  branches: GitHubBranchRecord[];
  issues: GitHubIssueRecord[];
  pullRequests: GitHubRepositoryDetailsResult['pullRequests'];
  onActiveLabelsChange(labels: ReadonlySet<string>): void;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onIssueCreated(issue: GitHubIssueRecord): void;
  onOpenIssue(issueNumber: number): void;
  onQueryChange(query: string): void;
  onViewModeChange(viewMode: IssueViewMode): void;
  query: string;
  repository?: GitHubCatalogRepository;
  viewMode: IssueViewMode;
}) {
  const repoFullName = repository?.fullName;
  const [overrides, setOverrides] = useState<IssueColumnOverrides>(() =>
    loadIssueColumnOverrides(repoFullName)
  );
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<IssueColumnId>>(() =>
    loadHiddenIssueColumns()
  );
  const [columnOrder, setColumnOrder] = useState<IssueColumnId[]>(() => loadIssueColumnOrder());
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    setOverrides(loadIssueColumnOverrides(repoFullName));
  }, [repoFullName]);

  const filteredIssues = filterIssues(issues, query, activeLabels);
  const labels = topIssueLabels(issues);
  const hasFilter = query.trim().length > 0 || activeLabels.size > 0;
  const orderedColumns = orderedIssueColumns(columnOrder);
  const visibleColumns = orderedColumns.filter((column) => !hiddenColumns.has(column.id));
  const columnGroups = groupIssuesByColumn(filteredIssues, overrides);

  const moveIssue = async (issueNumber: number, columnId: IssueColumnId) => {
    const issue = issues.find((entry) => entry.number === issueNumber);
    const shouldClose = columnId === 'closed';
    const shouldReopen = issue?.state === 'closed' && columnId !== 'closed';

    if (repository && issue && (shouldClose || shouldReopen)) {
      const result = await projectSpaceClient.updateGitHubIssue({
        fullName: repository.fullName,
        number: issueNumber,
        state: shouldClose ? 'closed' : 'open'
      });

      if (result.status === 'connected' && result.issue) {
        onIssueCreated(result.issue);
      }
    }

    setOverrides((previous) => {
      const next = { ...previous, [issueNumber]: columnId };

      saveIssueColumnOverrides(repoFullName, next);
      return next;
    });
  };

  const toggleColumn = (columnId: IssueColumnId) => {
    setHiddenColumns((previous) => {
      const next = new Set(previous);

      if (next.has(columnId)) {
        next.delete(columnId);
      } else {
        next.add(columnId);
      }

      saveHiddenIssueColumns(next);
      return next;
    });
  };

  const moveColumn = (columnId: IssueColumnId, direction: -1 | 1) => {
    setColumnOrder((previous) => {
      const next = [...previous];
      const index = next.indexOf(columnId);
      const targetIndex = index + direction;

      if (index < 0 || targetIndex < 0 || targetIndex >= next.length) {
        return previous;
      }

      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      saveIssueColumnOrder(next);
      return next;
    });
  };

  const toggleLabel = (label: string) => {
    const next = new Set(activeLabels);

    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }

    onActiveLabelsChange(next);
  };

  const createIssue = async (values: IssueFormValues) => {
    if (!repository) {
      return;
    }

    setCreateError('');
    const result = await projectSpaceClient.createGitHubIssue({
      body: values.body,
      fullName: repository.fullName,
      labels: values.labels,
      title: values.title
    });

    if (result.status !== 'connected' || !result.issue) {
      setCreateError(result.message ?? 'Could not create issue.');
      return;
    }

    onIssueCreated(result.issue);
    setIsCreating(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex min-w-0 shrink-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Issues</Text>
          <Text className="rounded-full border border-neutral-800 bg-neutral-900/70 px-2 py-0.5 font-mono text-[11px] tabular-nums text-neutral-400">
            {hasFilter ? `${filteredIssues.length}/${issues.length}` : issues.length}
          </Text>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {repository ? (
            <Button
              size="sm"
              variant={isCreating ? 'ghost' : 'secondary'}
              onPress={() => {
                setCreateError('');
                setIsCreating((value) => !value);
              }}
            >
              {isCreating ? <X className="size-4" /> : <Plus className="size-4" />}
              {isCreating ? 'Cancel' : 'New issue'}
            </Button>
          ) : null}
          <SearchField
            aria-label="Search issues"
            value={query}
            onChange={onQueryChange}
            className="w-64 max-w-full rounded-lg border border-neutral-800 bg-neutral-900/50 transition focus-within:border-neutral-600"
          >
            <SearchFieldGroup className="px-2.5 py-1">
              <SearchFieldSearchIcon />
              <SearchFieldInput placeholder="Search title, label, #number" className="text-sm" />
              <SearchFieldClearButton />
            </SearchFieldGroup>
          </SearchField>
          <ToggleButtonGroup
            aria-label="Issue view"
            selectedKeys={new Set([viewMode])}
            onSelectionChange={(keys) => {
              const nextMode = Array.from(keys)[0];

              if (nextMode === 'list' || nextMode === 'board') {
                onViewModeChange(nextMode);
              }
            }}
            className="shrink-0 rounded-lg bg-neutral-900/70 p-1"
          >
            <ToggleButton id="list" className="h-7 gap-1.5 rounded-md px-2 text-xs">
              <List className="size-3.5" />
              List
            </ToggleButton>
            <ToggleButton id="board" className="h-7 gap-1.5 rounded-md px-2 text-xs">
              <Columns3 className="size-3.5" />
              Board
            </ToggleButton>
          </ToggleButtonGroup>
          {viewMode === 'board' ? (
            <Dropdown>
              <DropdownTrigger
                aria-label="Show or hide board columns"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg border-neutral-800 bg-neutral-900/50 text-neutral-400 hover:text-neutral-200"
              >
                <SlidersHorizontal className="size-4" />
              </DropdownTrigger>
              <DropdownPopover className="w-64">
                <DropdownMenu aria-label="Toggle board columns">
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
                    Board columns
                  </div>
                  {orderedColumns.map((column, index) => {
                    const isVisible = !hiddenColumns.has(column.id);
                    const isLastVisible = isVisible && visibleColumns.length === 1;

                    return (
                      <div
                        key={column.id}
                        className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900/80"
                      >
                        <button
                          type="button"
                          disabled={isLastVisible}
                          onClick={() => toggleColumn(column.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
                        >
                          <span
                            className={cn(
                              'flex size-4 shrink-0 items-center justify-center rounded border transition',
                              isVisible
                                ? 'border-neutral-400 bg-neutral-200 text-neutral-900'
                                : 'border-neutral-700 text-transparent'
                            )}
                          >
                            {isVisible ? <Check className="size-3" strokeWidth={3} /> : null}
                          </span>
                          <span
                            className={cn('size-1.5 shrink-0 rounded-full', column.dotClass)}
                          />
                          <span className="min-w-0 flex-1 truncate">{column.label}</span>
                          <span className="font-mono text-[10px] tabular-nums text-neutral-600">
                            {columnGroups[column.id].length}
                          </span>
                        </button>
                        <button
                          type="button"
                          disabled={index === 0}
                          onClick={() => moveColumn(column.id, -1)}
                          className="flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:pointer-events-none disabled:opacity-25"
                          aria-label={`Move ${column.label} left`}
                        >
                          <ChevronLeft className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={index === orderedColumns.length - 1}
                          onClick={() => moveColumn(column.id, 1)}
                          className="flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:pointer-events-none disabled:opacity-25"
                          aria-label={`Move ${column.label} right`}
                        >
                          <ChevronRight className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </DropdownMenu>
              </DropdownPopover>
            </Dropdown>
          ) : null}
        </div>
      </div>

      {isCreating && repository ? (
        <IssueEditor
          error={createError}
          initialBody=""
          initialLabels={[]}
          initialTitle=""
          onCancel={() => {
            setCreateError('');
            setIsCreating(false);
          }}
          onSubmit={createIssue}
          submitLabel="Create issue"
        />
      ) : null}

      {labels.length > 0 ? (
        <div className="mb-3 flex shrink-0 flex-wrap items-center gap-1.5">
          <Tags className="size-3.5 text-neutral-600" />
          {labels.map((label) => {
            const active = activeLabels.has(label);

            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={() => toggleLabel(label)}
                style={active ? labelChipStyle(label) : undefined}
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[11px] font-medium transition',
                  !active &&
                    'border-neutral-800 text-neutral-500 hover:border-neutral-700 hover:text-neutral-300'
                )}
              >
                {label}
              </button>
            );
          })}
          {activeLabels.size > 0 ? (
            <button
              type="button"
              onClick={() => onActiveLabelsChange(new Set())}
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] text-neutral-500 transition hover:text-neutral-200"
            >
              <X className="size-3" />
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {isLoading && issues.length === 0 ? (
        <IssueBoardSkeleton viewMode={viewMode} />
      ) : issues.length === 0 ? (
        <IssueEmptyState message={emptyMessage} repository={repository} />
      ) : filteredIssues.length === 0 ? (
        <IssueEmptyState message="No issues match the current filters." />
      ) : viewMode === 'board' ? (
        <IssueKanbanBoard
          branches={branches}
          defaultBranch={branches.find((branch) => branch.isDefault)?.name ?? 'main'}
          issues={filteredIssues}
          onBranchCreated={onBranchCreated}
          onMoveIssue={moveIssue}
          onOpenIssue={onOpenIssue}
          pullRequests={pullRequests}
          repoFullName={repository?.fullName}
          overrides={overrides}
          visibleColumns={visibleColumns}
        />
      ) : (
        <IssueListView
          branches={branches}
          defaultBranch={branches.find((branch) => branch.isDefault)?.name ?? 'main'}
          issues={filteredIssues}
          onBranchCreated={onBranchCreated}
          onOpenIssue={onOpenIssue}
          pullRequests={pullRequests}
          repoFullName={repository?.fullName}
        />
      )}
    </div>
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
            <span
              className="h-3 rounded bg-neutral-800/60"
              style={{ width: `${34 + ((index * 13) % 40)}%` }}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden pb-2">
      {orderedIssueColumns(loadIssueColumnOrder()).map((column) => (
        <div
          key={column.id}
          className="flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40"
        >
          <div className="flex items-center gap-2 border-b border-neutral-800/60 px-3 py-2.5">
            <span className={cn('size-1.5 rounded-full opacity-60', column.dotClass)} />
            <Text className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
              {column.label}
            </Text>
          </div>
          <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className="animate-pulse rounded-lg border border-neutral-800/60 bg-neutral-900/40 p-3"
              >
                <span className="block h-2.5 w-12 rounded bg-neutral-800/80" />
                <span className="mt-2.5 block h-3 w-4/5 rounded bg-neutral-800/60" />
                <span className="mt-1.5 block h-3 w-3/5 rounded bg-neutral-800/50" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function IssueEmptyState({
  message,
  repository
}: {
  message: string;
  repository?: GitHubCatalogRepository;
}) {
  return (
    <div className="issue-rise-in flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-neutral-800/80 p-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/60">
        <Inbox className="size-5 text-neutral-500" />
      </span>
      <Text className="max-w-sm text-sm text-neutral-400">{message}</Text>
      {repository ? (
        <a
          href={`${repository.url}/issues`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition hover:text-neutral-200"
        >
          <GitHubMark className="size-3.5" />
          Open issues on GitHub
          <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}

function IssueDetailWorkbench({
  branches,
  connectorOverview,
  issue,
  issues,
  onBranchCreated,
  onIssueUpdated,
  onOpenIssue,
  onPullRequestCreated,
  project,
  projects,
  repoFullName,
  repoUrl,
  targetPath
}: {
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
  repoFullName?: string;
  repoUrl?: string;
  targetPath: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(13rem,0.55fr)_minmax(0,1.2fr)_minmax(14rem,0.6fr)]">
      <IssueDetailList
        issues={issues}
        onOpenIssue={onOpenIssue}
        repoFullName={repoFullName}
        selectedIssueNumber={issue.number}
      />
      <IssueBody issue={issue} onIssueUpdated={onIssueUpdated} repoFullName={repoFullName} />
      <IssueActionPanel
        branches={branches}
        connectorOverview={connectorOverview}
        issue={issue}
        onBranchCreated={onBranchCreated}
        onIssueUpdated={onIssueUpdated}
        onPullRequestCreated={onPullRequestCreated}
        project={project}
        projects={projects}
        repoFullName={repoFullName}
        repoUrl={repoUrl}
        targetPath={targetPath}
      />
    </div>
  );
}
