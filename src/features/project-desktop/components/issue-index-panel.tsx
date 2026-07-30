import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Inbox } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHubBranchRecord,
  GitHubCatalogRepository,
  GitHubIssueRecord,
  GitHubRepositoryDetailsResult
} from '@/shared/project-space-api';
import type { RoadmapController } from '../../roadmap/use-roadmap';
import { RoadmapIssuesGraphView } from '../../roadmap/roadmap-issues-graph-view';
import { GitHubMark } from './github-mark';
import { IssueBoardSettings } from './issue-board-settings';
import {
  browserIssueCreationHistory,
  IssueCreationHistoryController
} from './issue-creation-history';
import { IssueCreationOverlay } from './issue-creation-overlay';
import { isIssueCreationPath } from './issue-creation-route';
import { IssueFilterOverlay } from './issue-filter-overlay';
import { IssueKanbanBoard } from './issue-kanban-board';
import { IssueListView } from './issue-list-view';
import { IssueMobileActionBar, IssueToolbar } from './issue-toolbar';
import {
  filterIssues,
  groupIssuesByColumn,
  loadHiddenIssueColumns,
  loadIssueColumnOrder,
  orderedIssueColumns,
  saveHiddenIssueColumns,
  saveIssueColumnOrder,
  topIssueLabels,
  type IssueColumnId,
  type IssueViewMode
} from './issue-board-model';

interface IssueIndexPanelProps {
  activeLabels: ReadonlySet<string>;
  branches: GitHubBranchRecord[];
  emptyMessage: string;
  evidenceState: 'blocked' | 'loading' | 'ready';
  isLoading: boolean;
  issues: GitHubIssueRecord[];
  onActiveLabelsChange(labels: ReadonlySet<string>): void;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onIssueCreated(issue: GitHubIssueRecord): void;
  onOpenIssue(issueNumber: number): void;
  onQueryChange(query: string): void;
  onRetry?(): void;
  onViewModeChange(viewMode: IssueViewMode): void;
  projectId: string;
  pullRequests: GitHubRepositoryDetailsResult['pullRequests'];
  query: string;
  roadmap?: RoadmapController;
  repository?: GitHubCatalogRepository;
  viewMode: IssueViewMode;
}

export function IssueIndexPanel(props: IssueIndexPanelProps) {
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<IssueColumnId>>(() =>
    loadHiddenIssueColumns()
  );
  const [columnOrder, setColumnOrder] = useState<IssueColumnId[]>(() => loadIssueColumnOrder());
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [isCreationOpen, setIsCreationOpen] = useState(() =>
    typeof window !== 'undefined'
      && isIssueCreationPath(window.location.pathname, props.projectId)
  );
  const [creationCloseRequest, setCreationCloseRequest] = useState(0);
  const creationHistoryRef = useRef<IssueCreationHistoryController | null>(null);
  const creationSucceededRef = useRef(false);
  const creationTriggerRef = useRef<HTMLElement | null>(null);
  const pendingCreatedIssueRef = useRef<{
    issue: GitHubIssueRecord;
    repositoryKey: string;
  } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const closeFilter = useCallback(() => setIsFilterOpen(false), []);
  const restoreCreationTrigger = useCallback(() => {
    const trigger = creationTriggerRef.current;
    window.requestAnimationFrame(() => {
      if (!creationSucceededRef.current && trigger?.isConnected) trigger.focus();
    });
  }, []);

  useEffect(() => {
    const controller = new IssueCreationHistoryController(
      props.projectId,
      browserIssueCreationHistory(),
      {
        onCloseRequest: () => setCreationCloseRequest((request) => request + 1),
        onClosed: () => {
          setIsCreationOpen(false);
          const pending = pendingCreatedIssueRef.current;
          pendingCreatedIssueRef.current = null;
          if (
            pending
            && pending.repositoryKey === propsRef.current.repository?.fullName
          ) {
            propsRef.current.onIssueCreated(pending.issue);
            propsRef.current.onOpenIssue(pending.issue.number);
          } else {
            restoreCreationTrigger();
          }
        },
        onOpen: () => {
          creationSucceededRef.current = false;
          pendingCreatedIssueRef.current = null;
          setIsCreationOpen(true);
        }
      }
    );
    creationHistoryRef.current = controller;
    setIsCreationOpen(controller.isOpen());

    const handlePopState = () => controller.handlePopState();
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
      if (creationHistoryRef.current === controller) creationHistoryRef.current = null;
    };
  }, [props.projectId, restoreCreationTrigger]);

  const closeCreation = useCallback(() => {
    creationHistoryRef.current?.finishClose();
  }, []);

  const openCreation = useCallback(() => {
    if (!props.repository) return;
    const activeElement = document.activeElement;
    creationTriggerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    creationSucceededRef.current = false;
    pendingCreatedIssueRef.current = null;
    creationHistoryRef.current?.openFromControl();
  }, [props.repository]);

  const revealCreatedIssue = useCallback((issue: GitHubIssueRecord, repositoryKey: string) => {
    if (repositoryKey !== props.repository?.fullName) return;

    creationSucceededRef.current = true;
    const controller = creationHistoryRef.current;
    if (controller?.isOpen()) {
      pendingCreatedIssueRef.current = { issue, repositoryKey };
      return;
    }

    props.onIssueCreated(issue);
    props.onOpenIssue(issue.number);
  }, [props]);

  const filteredIssues = filterIssues(props.issues, props.query, props.activeLabels);
  const labels = topIssueLabels(props.issues);
  const hasFilter = props.query.trim().length > 0 || props.activeLabels.size > 0;
  const orderedColumns = orderedIssueColumns(columnOrder);
  const visibleColumns = orderedColumns.filter((column) => !hiddenColumns.has(column.id));
  const columnGroups = groupIssuesByColumn(filteredIssues, props.pullRequests);

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
    <div className={cn(
      'relative flex min-h-0 flex-1 flex-col',
      props.viewMode === 'graph' ? 'pb-0' : 'pb-20 sm:pb-0'
    )}>
      <IssueToolbar
        countState={props.evidenceState}
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

      {props.viewMode !== 'graph' && props.roadmap?.error ? (
        <div role="alert" className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {props.roadmap.error}
        </div>
      ) : null}
      {props.viewMode !== 'graph' && props.roadmap?.result?.dependencySync === 'stale' ? (
        <div role="alert" className="mb-3 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
          GitHub prerequisites are stale. Plan editing is paused until refresh succeeds.
        </div>
      ) : null}
      {props.viewMode !== 'graph' ? (
        <div aria-live="polite" className="sr-only">{props.roadmap?.announcement}</div>
      ) : null}

      {props.viewMode === 'board' ? (
        <>
          <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
            <Text className="text-xs font-medium leading-5 text-neutral-400">
              GitHub-derived · Issues with a linked pull request are in progress
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
        </>
      ) : null}

      <IssueContent
        {...props}
        filteredIssues={filteredIssues}
        visibleColumns={visibleColumns}
      />

      {props.viewMode !== 'graph' ? (
        <IssueMobileActionBar
          isCreateDisabled={!props.repository}
          onCreate={openCreation}
          onFilter={() => setIsFilterOpen(true)}
          onQueryChange={props.onQueryChange}
          query={props.query}
        />
      ) : null}
      <IssueFilterOverlay
        activeLabels={props.activeLabels}
        labels={labels}
        onActiveLabelsChange={props.onActiveLabelsChange}
        onClose={closeFilter}
        open={isFilterOpen}
      />
      <IssueCreationOverlay
        closeRequest={creationCloseRequest}
        onClose={closeCreation}
        onIssueCreated={revealCreatedIssue}
        open={isCreationOpen}
        repository={props.repository}
      />
    </div>
  );
}

function IssueContent({
  branches,
  emptyMessage,
  evidenceState,
  filteredIssues,
  isLoading,
  issues,
  onBranchCreated,
  onOpenIssue,
  onRetry,
  pullRequests,
  repository,
  roadmap,
  viewMode,
  visibleColumns
}: IssueIndexPanelProps & {
  filteredIssues: GitHubIssueRecord[];
  visibleColumns: ReturnType<typeof orderedIssueColumns>;
}) {
  if (viewMode === 'graph') {
    return roadmap ? (
      <RoadmapIssuesGraphView
        issueError={evidenceState === 'blocked' ? emptyMessage : undefined}
        issues={issues}
        isLoadingIssues={isLoading}
        roadmap={roadmap}
        repository={repository}
      />
    ) : <IssueEmptyState message="The graph is unavailable for this project." />;
  }
  if (isLoading && issues.length === 0) return <IssueIndexSkeleton viewMode={viewMode} />;
  if (issues.length === 0) {
    return (
      <IssueEmptyState
        message={emptyMessage}
        onRetry={evidenceState === 'blocked' ? onRetry : undefined}
        repository={repository}
      />
    );
  }
  if (filteredIssues.length === 0) return <IssueEmptyState message="No issues match the current filters." />;
  if (viewMode === 'board') {
    return (
      <IssueKanbanBoard
        branches={branches}
        defaultBranch={branches.find((branch) => branch.isDefault)?.name ?? 'main'}
        issues={filteredIssues}
        onBranchCreated={onBranchCreated}
        onOpenIssue={onOpenIssue}
        pullRequests={pullRequests}
        repoFullName={repository?.fullName}
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
      roadmap={roadmap}
      repoFullName={repository?.fullName}
    />
  );
}

function IssueIndexSkeleton({ viewMode }: { viewMode: IssueViewMode }) {
  return (
    <div className={cn('flex min-h-0 flex-1 gap-3 overflow-hidden', viewMode !== 'board' && 'flex-col')}>
      {Array.from({ length: viewMode === 'list' ? 8 : 4 }, (_, index) => (
        <div
          key={index}
          className={cn(
            'animate-pulse rounded-xl border border-neutral-800/70 bg-neutral-950/40',
            viewMode === 'list' ? 'h-11 w-full' : viewMode === 'graph' ? 'h-full w-full' : 'h-full w-80 shrink-0'
          )}
        />
      ))}
    </div>
  );
}

function IssueEmptyState({
  message,
  onRetry,
  repository
}: {
  message: string;
  onRetry?(): void;
  repository?: GitHubCatalogRepository;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-neutral-800/80 p-8 text-center">
      <span className="flex size-11 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/60">
        <Inbox className="size-5 text-neutral-500" />
      </span>
      <Text className="max-w-sm text-sm text-neutral-400">{message}</Text>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-10 rounded-lg px-3 text-xs font-medium text-neutral-300 transition hover:bg-neutral-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 sm:min-h-8"
        >
          Retry
        </button>
      ) : null}
      {repository ? (
        <a href={`${repository.url}/issues`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-200">
          <GitHubMark className="size-3.5" /> Open issues on GitHub <ExternalLink className="size-3" />
        </a>
      ) : null}
    </div>
  );
}
