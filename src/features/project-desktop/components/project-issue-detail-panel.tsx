import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Columns3,
  ExternalLink,
  GitBranchPlus,
  Inbox,
  List,
  ListChecks,
  Play,
  Rocket,
  SlidersHorizontal,
  Tags,
  X
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Button,
  Dropdown,
  DropdownItem,
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
  GitHubCatalogRepository,
  GitHubIssueRecord,
  GitHubRepositoryDetailsResult
} from '@/shared/project-space-api';
import { GitHubMark } from './github-mark';
import {
  filterIssues,
  groupIssuesByColumn,
  issueColumns,
  issueUpdatedAtLabel,
  labelChipStyle,
  loadHiddenIssueColumns,
  loadIssueColumnOverrides,
  loadIssueViewMode,
  resolveIssueColumn,
  saveHiddenIssueColumns,
  saveIssueColumnOverrides,
  saveIssueViewMode,
  topIssueLabels,
  type IssueColumnId,
  type IssueColumnOverrides,
  type IssueViewMode
} from './issue-board-model';
import { IssueKanbanBoard } from './issue-kanban-board';
import { IssueListView } from './issue-list-view';
import { IssueAuthorAvatar, IssueLabelChip, IssueStatusDot } from './issue-visuals';
import { IssueMarkdown } from './issue-markdown';
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

  return { details, error, isLoading };
}

export function ProjectIssueDetailPanel({
  issueNumber,
  onBack,
  onOpenIssue,
  repository
}: {
  issueNumber?: number;
  onBack(): void;
  onOpenIssue(issueNumber: number): void;
  repository?: GitHubCatalogRepository;
}) {
  const { details, error, isLoading } = useRepositoryDetails(repository);
  const [viewMode, setViewMode] = useState<IssueViewMode>(() => loadIssueViewMode());
  const [query, setQuery] = useState('');
  const [activeLabels, setActiveLabels] = useState<ReadonlySet<string>>(() => new Set());

  const safeDetails = details ?? repositoryDetailsFallback(repository ? 'connected' : 'error');
  const issues = safeDetails.issues;
  const issue = issues.find((entry) => entry.number === issueNumber);
  const emptyMessage =
    error ||
    safeDetails.message ||
    (!repository ? 'No GitHub repository is linked to this project.' : 'No open issues.');

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
          issue={issue}
          issues={issues}
          onOpenIssue={onOpenIssue}
          repoFullName={repository?.fullName}
        />
      ) : issueNumber ? (
        <IssueEmptyState
          message={details ? 'Issue was not found in the loaded open issues.' : emptyMessage}
        />
      ) : (
        <IssueIndex
          activeLabels={activeLabels}
          emptyMessage={emptyMessage}
          isLoading={isLoading}
          issues={issues}
          onActiveLabelsChange={setActiveLabels}
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
  issues,
  onActiveLabelsChange,
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
  issues: GitHubIssueRecord[];
  onActiveLabelsChange(labels: ReadonlySet<string>): void;
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

  useEffect(() => {
    setOverrides(loadIssueColumnOverrides(repoFullName));
  }, [repoFullName]);

  const filteredIssues = filterIssues(issues, query, activeLabels);
  const labels = topIssueLabels(issues);
  const hasFilter = query.trim().length > 0 || activeLabels.size > 0;
  const visibleColumns = issueColumns.filter((column) => !hiddenColumns.has(column.id));
  const columnGroups = groupIssuesByColumn(filteredIssues, overrides);

  const moveIssue = (issueNumber: number, columnId: IssueColumnId) => {
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

  const toggleLabel = (label: string) => {
    const next = new Set(activeLabels);

    if (next.has(label)) {
      next.delete(label);
    } else {
      next.add(label);
    }

    onActiveLabelsChange(next);
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
              <DropdownPopover className="w-52">
                <DropdownMenu aria-label="Toggle board columns">
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
                    Board columns
                  </div>
                  {issueColumns.map((column) => {
                    const isVisible = !hiddenColumns.has(column.id);
                    const isLastVisible = isVisible && visibleColumns.length === 1;

                    return (
                      <DropdownItem
                        key={column.id}
                        isDisabled={isLastVisible}
                        onClick={(event) => {
                          // Keep the menu open so several columns can be toggled in a row.
                          event.preventDefault();
                          toggleColumn(column.id);
                        }}
                        className="flex items-center gap-2 text-xs"
                      >
                        <span
                          className={cn(
                            'flex size-4 shrink-0 items-center justify-center rounded border transition',
                            isVisible
                              ? 'border-neutral-400 bg-neutral-200 text-neutral-900'
                              : 'border-neutral-700 text-transparent'
                          )}
                        >
                          <Check className="size-3" strokeWidth={3} />
                        </span>
                        <span className={cn('size-1.5 shrink-0 rounded-full', column.dotClass)} />
                        {column.label}
                        <span className="ml-auto font-mono text-[10px] tabular-nums text-neutral-600">
                          {columnGroups[column.id].length}
                        </span>
                      </DropdownItem>
                    );
                  })}
                </DropdownMenu>
              </DropdownPopover>
            </Dropdown>
          ) : null}
        </div>
      </div>

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
          issues={filteredIssues}
          onMoveIssue={moveIssue}
          onOpenIssue={onOpenIssue}
          overrides={overrides}
          visibleColumns={visibleColumns}
        />
      ) : (
        <IssueListView
          issues={filteredIssues}
          onOpenIssue={onOpenIssue}
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
    <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] gap-3 lg:grid-cols-2 xl:grid-cols-4">
      {issueColumns.map((column) => (
        <div
          key={column.id}
          className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40"
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
  issue,
  issues,
  onOpenIssue,
  repoFullName
}: {
  issue: GitHubIssueRecord;
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
  repoFullName?: string;
}) {
  return (
    <div className="grid min-h-0 flex-1 gap-4 overflow-hidden lg:grid-cols-[minmax(13rem,0.55fr)_minmax(0,1.2fr)_minmax(14rem,0.6fr)]">
      <IssueDetailList
        issues={issues}
        onOpenIssue={onOpenIssue}
        repoFullName={repoFullName}
        selectedIssueNumber={issue.number}
      />
      <IssueBody issue={issue} />
      <IssueActionPanel issue={issue} />
    </div>
  );
}

function IssueDetailList({
  issues,
  onOpenIssue,
  repoFullName,
  selectedIssueNumber
}: {
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
  repoFullName?: string;
  selectedIssueNumber: number;
}) {
  const [overrides, setOverrides] = useState<IssueColumnOverrides>(() =>
    loadIssueColumnOverrides(repoFullName)
  );

  useEffect(() => {
    setOverrides(loadIssueColumnOverrides(repoFullName));
  }, [repoFullName]);

  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800/60 px-3 py-2.5">
        <Text className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-300">
          Open issues
        </Text>
        <Text className="ml-auto font-mono text-[11px] tabular-nums text-neutral-500">
          {issues.length}
        </Text>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
        {issues.map((entry, index) => {
          const isSelected = entry.number === selectedIssueNumber;

          return (
            <button
              key={entry.number}
              type="button"
              onClick={() => onOpenIssue(entry.number)}
              aria-current={isSelected ? 'true' : undefined}
              className={cn(
                'relative min-w-0 rounded-lg px-2.5 py-2 text-left transition',
                isSelected ? 'bg-neutral-800/80' : 'hover:bg-neutral-900/60'
              )}
            >
              {isSelected ? (
                <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-neutral-100" />
              ) : null}
              <span className="flex items-center gap-1.5">
                <IssueStatusDot columnId={resolveIssueColumn(entry, index, overrides)} />
                <Text className="font-mono text-[11px] tabular-nums text-neutral-500">
                  #{entry.number}
                </Text>
              </span>
              <Text
                className={cn(
                  'mt-0.5 block truncate text-sm',
                  isSelected ? 'font-medium text-neutral-50' : 'text-neutral-300'
                )}
              >
                {entry.title}
              </Text>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function IssueBody({ issue }: { issue: GitHubIssueRecord }) {
  const updated = issueUpdatedAtLabel(issue);

  return (
    <article className="issue-rise-in min-h-0 min-w-0 overflow-y-auto pr-3">
      <div className="flex min-w-0 items-center gap-2">
        <Text className="font-mono text-xs tabular-nums text-neutral-500">#{issue.number}</Text>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
            issue.state === 'open'
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
              : 'border-neutral-700 bg-neutral-800/60 text-neutral-400'
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              issue.state === 'open' ? 'bg-emerald-400' : 'bg-neutral-500'
            )}
          />
          {issue.state}
        </span>
      </div>

      <Text
        as="h1"
        className="mt-3 block text-2xl font-semibold leading-tight tracking-tight text-neutral-50"
      >
        {issue.title}
      </Text>

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {issue.author ? (
          <span className="flex items-center gap-1.5">
            <IssueAuthorAvatar author={issue.author} className="size-5 text-[10px]" />
            <Text className="text-xs text-neutral-400">{issue.author}</Text>
          </span>
        ) : null}
        {updated ? (
          <Text className="font-mono text-[11px] text-neutral-600">updated {updated} ago</Text>
        ) : null}
      </div>

      {issue.labels.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {issue.labels.map((label) => (
            <IssueLabelChip key={label} label={label} className="text-[11px]" />
          ))}
        </div>
      ) : null}

      <div className="mt-5 h-px bg-neutral-800/80" />

      <IssueMarkdown markdown={issue.body} />
    </article>
  );
}

function IssueActionPanel({ issue }: { issue: GitHubIssueRecord }) {
  return (
    <aside className="grid min-w-0 content-start gap-3 overflow-y-auto">
      <section className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
        <div className="mb-3 flex items-center gap-2">
          <Play className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Development session</Text>
        </div>
        <Text className="mb-3 block text-sm text-neutral-500">
          Start work from issue{' '}
          <span className="font-mono text-neutral-300">#{issue.number}</span>.
        </Text>
        <div className="grid gap-2">
          <Button variant="secondary">
            <GitBranchPlus className="size-4" />
            Start branch
          </Button>
          <Button variant="ghost">
            <Play className="size-4" />
            Run tests
          </Button>
          <Button variant="ghost">
            <Rocket className="size-4" />
            Create PR
          </Button>
        </div>
      </section>

      <section className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
        <Text className="mb-2.5 block text-sm font-semibold text-neutral-100">Details</Text>
        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">State</Text>
            <Text className="text-neutral-200">{issue.state}</Text>
          </div>
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Author</Text>
            <Text className="truncate text-neutral-200">{issue.author ?? 'unknown'}</Text>
          </div>
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Updated</Text>
            <Text className="truncate font-mono text-xs text-neutral-300">
              {issue.updatedAt ? new Date(issue.updatedAt).toLocaleDateString() : 'unknown'}
            </Text>
          </div>
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Labels</Text>
            <Text className="font-mono text-xs tabular-nums text-neutral-300">
              {issue.labels.length}
            </Text>
          </div>
        </div>
      </section>
    </aside>
  );
}
