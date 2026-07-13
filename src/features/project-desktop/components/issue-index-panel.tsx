import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Inbox } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHubBranchRecord,
  GitHubCatalogRepository,
  GitHubIssueRecord,
  GitHubRepositoryDetailsResult
} from '@/shared/project-space-api';
import { routeForView } from '../hooks/project-desktop-routing';
import { GitHubMark } from './github-mark';
import { IssueBoardSettings } from './issue-board-settings';
import { IssueCreationOverlay } from './issue-creation-overlay';
import { IssueFilterOverlay } from './issue-filter-overlay';
import { IssueKanbanBoard } from './issue-kanban-board';
import { IssueListView } from './issue-list-view';
import { IssueMobileActionBar, IssueToolbar } from './issue-toolbar';
import {
  filterIssues,
  groupIssuesByColumn,
  loadHiddenIssueColumns,
  loadIssueColumnOrder,
  loadIssueColumnOverrides,
  orderedIssueColumns,
  saveHiddenIssueColumns,
  saveIssueColumnOrder,
  saveIssueColumnOverrides,
  topIssueLabels,
  type IssueColumnId,
  type IssueColumnOverrides,
  type IssueViewMode
} from './issue-board-model';

interface IssueIndexPanelProps {
  activeLabels: ReadonlySet<string>;
  branches: GitHubBranchRecord[];
  emptyMessage: string;
  isLoading: boolean;
  issues: GitHubIssueRecord[];
  onActiveLabelsChange(labels: ReadonlySet<string>): void;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onIssueCreated(issue: GitHubIssueRecord): void;
  onOpenIssue(issueNumber: number): void;
  onQueryChange(query: string): void;
  onViewModeChange(viewMode: IssueViewMode): void;
  projectId: string;
  pullRequests: GitHubRepositoryDetailsResult['pullRequests'];
  query: string;
  repository?: GitHubCatalogRepository;
  viewMode: IssueViewMode;
}

function replaceIssueRoute(projectId: string, detail = '') {
  const nextPath = routeForView('project', projectId, 'issues', detail);
  const nextUrl = `${nextPath}${window.location.search}${window.location.hash}`;
  window.history.replaceState(null, '', nextUrl);
}

export function IssueIndexPanel(props: IssueIndexPanelProps) {
  const repoFullName = props.repository?.fullName;
  const [overrides, setOverrides] = useState<IssueColumnOverrides>(() =>
    loadIssueColumnOverrides(repoFullName)
  );
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<IssueColumnId>>(() =>
    loadHiddenIssueColumns()
  );
  const [columnOrder, setColumnOrder] = useState<IssueColumnId[]>(() => loadIssueColumnOrder());
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(
    () => typeof window !== 'undefined' && window.location.pathname.endsWith('/issues/new')
  );

  useEffect(() => {
    setOverrides(loadIssueColumnOverrides(repoFullName));
  }, [repoFullName]);

  useEffect(() => {
    const handlePopState = () => setIsCreating(window.location.pathname.endsWith('/issues/new'));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const closeFilter = useCallback(() => setIsFilterOpen(false), []);
  const closeCreation = useCallback(() => {
    setIsCreating(false);
    replaceIssueRoute(props.projectId);
  }, [props.projectId]);
  const openCreation = () => {
    if (!props.repository) return;
    setIsCreating(true);
    const nextPath = routeForView('project', props.projectId, 'issues', 'new');
    window.history.pushState(null, '', `${nextPath}${window.location.search}${window.location.hash}`);
  };

  const filteredIssues = filterIssues(props.issues, props.query, props.activeLabels);
  const labels = topIssueLabels(props.issues);
  const hasFilter = props.query.trim().length > 0 || props.activeLabels.size > 0;
  const orderedColumns = orderedIssueColumns(columnOrder);
  const visibleColumns = orderedColumns.filter((column) => !hiddenColumns.has(column.id));
  const columnGroups = groupIssuesByColumn(filteredIssues, overrides);

  const moveIssue = async (issueNumber: number, columnId: IssueColumnId) => {
    const issue = props.issues.find((entry) => entry.number === issueNumber);
    const shouldClose = columnId === 'closed';
    const shouldReopen = issue?.state === 'closed' && columnId !== 'closed';

    if (props.repository && issue && (shouldClose || shouldReopen)) {
      const result = await projectSpaceClient.updateGitHubIssue({
        fullName: props.repository.fullName,
        number: issueNumber,
        state: shouldClose ? 'closed' : 'open'
      });
      if (result.status === 'connected' && result.issue) props.onIssueCreated(result.issue);
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
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      saveHiddenIssueColumns(next);
      return next;
    });
  };

  const moveColumn = (columnId: IssueColumnId, direction: -1 | 1) => {
    setColumnOrder((previous) => {
      const next = [...previous];
      const index = next.indexOf(columnId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= next.length) return previous;
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      saveIssueColumnOrder(next);
      return next;
    });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col pb-20 sm:pb-0">
      <IssueToolbar
        filteredCount={filteredIssues.length}
        hasFilter={hasFilter}
        isCreateDisabled={!props.repository}
        onCreate={openCreation}
        onFilter={() => setIsFilterOpen(true)}
        onQueryChange={props.onQueryChange}
        onViewModeChange={props.onViewModeChange}
        query={props.query}
        totalCount={props.issues.length}
        viewMode={props.viewMode}
      />

      {props.viewMode === 'board' ? (
        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <Text className="text-[11px] text-neutral-600">
            Local placement · GitHub open/closed state stays authoritative
          </Text>
          <IssueBoardSettings
            counts={Object.fromEntries(
              orderedColumns.map((column) => [column.id, columnGroups[column.id].length])
            ) as Record<IssueColumnId, number>}
            hiddenColumns={hiddenColumns}
            onMoveColumn={moveColumn}
            onToggleColumn={toggleColumn}
            orderedColumns={orderedColumns}
            visibleColumnCount={visibleColumns.length}
          />
        </div>
      ) : null}

      <IssueContent
        {...props}
        filteredIssues={filteredIssues}
        onMoveIssue={moveIssue}
        overrides={overrides}
        visibleColumns={visibleColumns}
      />

      <IssueMobileActionBar
        isCreateDisabled={!props.repository}
        onCreate={openCreation}
        onFilter={() => setIsFilterOpen(true)}
        onQueryChange={props.onQueryChange}
        query={props.query}
      />
      <IssueFilterOverlay
        activeLabels={props.activeLabels}
        labels={labels}
        onActiveLabelsChange={props.onActiveLabelsChange}
        onClose={closeFilter}
        open={isFilterOpen}
      />
      <IssueCreationOverlay
        onClose={closeCreation}
        onIssueCreated={(issue) => {
          props.onIssueCreated(issue);
          closeCreation();
        }}
        open={isCreating}
        repository={props.repository}
      />
    </div>
  );
}

function IssueContent({
  branches,
  emptyMessage,
  filteredIssues,
  isLoading,
  issues,
  onBranchCreated,
  onMoveIssue,
  onOpenIssue,
  overrides,
  pullRequests,
  repository,
  viewMode,
  visibleColumns
}: IssueIndexPanelProps & {
  filteredIssues: GitHubIssueRecord[];
  onMoveIssue(issueNumber: number, columnId: IssueColumnId): void;
  overrides: IssueColumnOverrides;
  visibleColumns: ReturnType<typeof orderedIssueColumns>;
}) {
  if (isLoading && issues.length === 0) return <IssueIndexSkeleton viewMode={viewMode} />;
  if (issues.length === 0) return <IssueEmptyState message={emptyMessage} repository={repository} />;
  if (filteredIssues.length === 0) return <IssueEmptyState message="No issues match the current filters." />;
  if (viewMode === 'board') {
    return (
      <IssueKanbanBoard
        branches={branches}
        defaultBranch={branches.find((branch) => branch.isDefault)?.name ?? 'main'}
        issues={filteredIssues}
        onBranchCreated={onBranchCreated}
        onMoveIssue={onMoveIssue}
        onOpenIssue={onOpenIssue}
        pullRequests={pullRequests}
        repoFullName={repository?.fullName}
        overrides={overrides}
        visibleColumns={visibleColumns}
      />
    );
  }
  return (
    <IssueListView
      branches={branches}
      defaultBranch={branches.find((branch) => branch.isDefault)?.name ?? 'main'}
      issues={filteredIssues}
      onBranchCreated={onBranchCreated}
      onOpenIssue={onOpenIssue}
      pullRequests={pullRequests}
      repoFullName={repository?.fullName}
    />
  );
}

function IssueIndexSkeleton({ viewMode }: { viewMode: IssueViewMode }) {
  return (
    <div className={cn('flex min-h-0 flex-1 gap-3 overflow-hidden', viewMode === 'list' && 'flex-col')}>
      {Array.from({ length: viewMode === 'list' ? 8 : 4 }, (_, index) => (
        <div
          key={index}
          className={cn(
            'animate-pulse rounded-xl border border-neutral-800/70 bg-neutral-950/40',
            viewMode === 'list' ? 'h-11 w-full' : 'h-full w-80 shrink-0'
          )}
        />
      ))}
    </div>
  );
}

function IssueEmptyState({ message, repository }: { message: string; repository?: GitHubCatalogRepository }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-neutral-800/80 p-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/60">
        <Inbox className="size-5 text-neutral-500" />
      </span>
      <Text className="max-w-sm text-sm text-neutral-400">{message}</Text>
      {repository ? (
        <a href={`${repository.url}/issues`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-200">
          <GitHubMark className="size-3.5" /> Open issues on GitHub <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}
