import { useEffect, useMemo, useRef, useState } from 'react';
import { Switch } from '@heroui/react';
import { AlertTriangle, Pencil, RefreshCw, Route } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import type { GitHubCatalogRepository, GitHubIssueRecord } from '@/shared/project-space-api';
import type { RoadmapIssueNode } from '@/shared/roadmap-api';
import { moveRoadmapItem } from '@/shared/roadmap-model';
import { RoadmapGoalEditor, type RoadmapEditorMode } from './roadmap-goal-editor';
import { RoadmapGraph } from './roadmap-graph';
import { RoadmapInspector } from './roadmap-inspector';
import { roadmapGraphVisibility } from './roadmap-model';
import { RoadmapWorkShelf, type RoadmapShelfDragFeedback } from './roadmap-work-shelf';
import type { RoadmapController } from './use-roadmap';
import { roadmapSelectedIssueId, useRoadmapSelection } from './use-roadmap-selection';

export function RoadmapIssuesGraphView({
  issueError,
  issues,
  isLoadingIssues,
  roadmap,
  repository
}: {
  issueError?: string;
  issues: readonly GitHubIssueRecord[];
  isLoadingIssues: boolean;
  roadmap: RoadmapController;
  repository?: GitHubCatalogRepository;
}) {
  const result = roadmap.result;
  const graphRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const [editorMode, setEditorMode] = useState<RoadmapEditorMode>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [dragFeedback, setDragFeedback] = useState<RoadmapShelfDragFeedback | null>(null);
  const compact = useCompactGraph();
  const {
    clear: clearSelection,
    select: selectSelection,
    selectedIssueId
  } = useRoadmapSelection(result?.repository.id);
  const visibility = useMemo(
    () => result ? roadmapGraphVisibility(result, showCompleted) : undefined,
    [result, showCompleted]
  );
  const visibleResult = useMemo(() => result && visibility ? {
    ...result,
    dependencies: visibility.dependencies,
    issues: visibility.issues
  } : undefined, [result, visibility]);
  const selectedIssue = visibility?.issues.find(
    (node) => node.issue.id === selectedIssueId
  );

  useEffect(() => {
    if (selectedIssueId && result && !selectedIssue) clearSelection();
  }, [clearSelection, result, selectedIssue, selectedIssueId]);

  if (!repository) return <GraphMessage title="No GitHub repository" message="Link a GitHub repository before planning work." />;
  if (roadmap.isLoading && !result) return <GraphSkeleton />;
  if (!result) return <GraphMessage title="Graph unavailable" message={roadmap.error || 'Could not load the roadmap.'} onRetry={roadmap.refresh} />;
  if (result.status !== 'connected') return <GraphMessage title="Graph unavailable" message={result.message ?? 'Connect GitHub to load planned work.'} onRetry={roadmap.refresh} />;

  const canEdit = result.canEdit && result.dependencySync === 'current';
  const addIssue = async (issue: GitHubIssueRecord, insertionIndex?: number) => {
    if (issue.id) selectSelection(issue.id);
    if (issue.state === 'closed') setShowCompleted(true);
    const saved = await roadmap.addIssue(issue.number, { insertionIndex, issue });
    if (!saved && issue.id && roadmapSelectedIssueId(window.location.search) === issue.id) {
      clearSelection();
    }
    return saved;
  };
  const selectIssue = (issue: RoadmapIssueNode) => selectSelection(issue.issue.id);
  const reorderIssue = (issue: RoadmapIssueNode, insertionIndex: number) => {
    const moved = moveRoadmapItem(
      result.plan.items,
      issue.issue,
      insertionIndex,
      result.dependencies
    );
    if (!moved) return Promise.resolve(false);
    selectSelection(issue.issue.id);
    return roadmap.savePlan(result.plan.goals, moved);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="mb-2 flex shrink-0 items-center gap-2 text-xs text-neutral-500">
        <Route className="size-3.5" />
        <span>{result.plan.items.length} planned</span>
        <span className="hidden sm:inline">· {result.dependencies.length} dependencies</span>
        <span className="hidden md:inline">· order and arrows are separate</span>
        <div className="ml-auto flex items-center gap-1.5">
          {visibility && visibility.completedCount > 0 ? (
            <Switch aria-label={`Show completed issues (${visibility.completedCount})`} isSelected={showCompleted} onChange={setShowCompleted} size="sm">
              <Switch.Content className="gap-1.5 text-[11px] text-neutral-400">
                <Switch.Control><Switch.Thumb /></Switch.Control>
                <span className="hidden sm:inline">Completed ({visibility.completedCount})</span>
              </Switch.Content>
            </Switch>
          ) : null}
          <Button aria-label="Edit goals" isDisabled={!canEdit || roadmap.isSaving} isIconOnly onPress={() => setEditorMode('goals')} size="sm" variant="ghost">
            <Pencil className="size-3.5" />
          </Button>
          <Button aria-label="Refresh graph" isDisabled={roadmap.isSaving} isIconOnly onPress={roadmap.refresh} size="sm" variant="ghost">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      {roadmap.error ? (
        <div role="alert" className="mb-2 shrink-0 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-100">
          {roadmap.error}
        </div>
      ) : null}
      {result.dependencySync === 'stale' ? (
        <div role="alert" className="mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-100">
          <AlertTriangle className="size-3.5" /> Relationship and order edits are paused until refresh succeeds.
        </div>
      ) : null}
      <div aria-live="polite" className="sr-only">{roadmap.announcement}</div>

      <RoadmapGoalEditor
        issueError={issueError}
        issues={issues}
        isLoadingIssues={isLoadingIssues}
        mode={editorMode}
        onModeChange={setEditorMode}
        roadmap={roadmap}
      />

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl">
        {visibleResult && visibility && visibility.issues.length > 0 ? (
          <RoadmapGraph
            compact={compact}
            containerRef={graphRef}
            dropTarget={dragFeedback}
            fill
            onSelect={selectIssue}
            onReorder={canEdit && !roadmap.isSaving ? reorderIssue : undefined}
            orderingResult={result}
            pendingIssueIds={roadmap.pendingIssueIds}
            result={visibleResult}
            selectedIssueId={selectedIssueId}
            withShelf
            dropExclusionRef={dockRef}
          />
        ) : (
          <div ref={graphRef} className="grid size-full min-h-80 place-items-center rounded-xl border border-dashed border-neutral-700 bg-neutral-950/35 p-8 text-center">
            <div>
              <Text className="block text-base font-semibold text-neutral-200">
                {result.plan.items.length === 0 ? 'Build the first graph branch' : 'All planned work is complete'}
              </Text>
              <Text className="mt-1 block text-sm text-neutral-500">
                {result.plan.items.length === 0 ? 'Drag an issue from the work dock into the canvas.' : 'Completed work is hidden without changing the saved plan.'}
              </Text>
              {result.plan.items.length > 0 ? <Button className="mt-4" onPress={() => setShowCompleted(true)} size="sm" variant="secondary">Show completed</Button> : null}
            </div>
          </div>
        )}

        <div className="absolute inset-x-2 bottom-2 z-30 md:inset-x-3 md:bottom-3" ref={dockRef}>
          <RoadmapWorkShelf
            canEdit={canEdit}
            dropExclusionRef={dockRef}
            error={issueError}
            graphRef={graphRef}
            isLoading={isLoadingIssues}
            isSaving={roadmap.isSaving}
            issues={issues}
            onAdd={addIssue}
            onDragFeedback={setDragFeedback}
            onRetry={roadmap.refresh}
            result={result}
            variant="dock"
          />
        </div>

        <RoadmapInspector
          issue={selectedIssue}
          issueError={issueError}
          issues={issues}
          isLoadingIssues={isLoadingIssues}
          onClose={clearSelection}
          overlay
          roadmap={roadmap}
        />
      </div>
    </div>
  );
}

function GraphSkeleton() {
  return <div aria-label="Loading graph" className="min-h-0 flex-1 animate-pulse rounded-xl bg-neutral-900/55" />;
}

function GraphMessage({ message, onRetry, title }: { message: string; onRetry?(): void; title: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
      <Text className="text-base font-semibold text-neutral-200">{title}</Text>
      <Text className="max-w-sm text-sm text-neutral-500">{message}</Text>
      {onRetry ? <Button onPress={onRetry} size="sm" variant="secondary">Retry</Button> : null}
    </div>
  );
}

function useCompactGraph() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return compact;
}
