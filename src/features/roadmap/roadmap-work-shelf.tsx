import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import { Label, SearchField } from '@heroui/react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GripVertical,
  Plus,
  RefreshCw
} from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import type { RoadmapResult } from '@/shared/roadmap-api';
import {
  pointIsInsideElement,
  roadmapWorkShelfAdditionIndex,
  roadmapWorkShelfIssues,
  roadmapWorkShelfPlanLabel
} from './roadmap-work-shelf-model';

const dragActivationDistance = 6;

export interface RoadmapShelfDragFeedback {
  active: boolean;
  overGraph: boolean;
  planLabel: string;
}

interface ShelfDragState {
  active: boolean;
  graphRevision: string;
  issue: GitHubIssueRecord;
  offsetX: number;
  offsetY: number;
  originX: number;
  originY: number;
  overGraph: boolean;
  planLabel: string;
  planRevision: number;
  width: number;
  x: number;
  y: number;
}

export function RoadmapWorkShelf({
  canEdit,
  error,
  graphRef,
  isLoading,
  isSaving,
  issues,
  onAdd,
  onDragFeedback,
  onRetry,
  result
}: {
  canEdit: boolean;
  error?: string;
  graphRef: RefObject<HTMLDivElement | null>;
  isLoading: boolean;
  isSaving: boolean;
  issues: readonly GitHubIssueRecord[];
  onAdd(issueNumber: number): Promise<boolean>;
  onDragFeedback(feedback: RoadmapShelfDragFeedback | null): void;
  onRetry(): void;
  result: RoadmapResult;
}) {
  const [query, setQuery] = useState('');
  const [drag, setDrag] = useState<ShelfDragState | null>(null);
  const [pendingIssueNumber, setPendingIssueNumber] = useState<number>();
  const dragRef = useRef<ShelfDragState | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const onAddRef = useRef(onAdd);
  const feedbackRef = useRef(onDragFeedback);
  const runAddRef = useRef<(issueNumber: number) => Promise<boolean>>(async () => false);
  const canAddRef = useRef(false);
  const graphRevisionRef = useRef(result.graphRevision);
  const planRevisionRef = useRef(result.plan.revision);
  onAddRef.current = onAdd;
  feedbackRef.current = onDragFeedback;
  graphRevisionRef.current = result.graphRevision;
  planRevisionRef.current = result.plan.revision;

  const shelfIssues = useMemo(
    () => roadmapWorkShelfIssues(issues, result, query),
    [issues, query, result]
  );
  const allUnplannedCount = useMemo(
    () => roadmapWorkShelfIssues(issues, result, '').length,
    [issues, result]
  );
  const canAdd = canEdit && !isSaving && pendingIssueNumber === undefined;
  const isDisabled = !canAdd;
  canAddRef.current = canAdd;

  const updateDrag = (next: ShelfDragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const runAdd = async (issueNumber: number) => {
    if (!canAddRef.current) return false;
    canAddRef.current = false;
    setPendingIssueNumber(issueNumber);
    try {
      return await onAddRef.current(issueNumber);
    } finally {
      setPendingIssueNumber(undefined);
    }
  };
  runAddRef.current = runAdd;

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    issue: GitHubIssueRecord
  ) => {
    const target = event.target as HTMLElement;
    const isTouchHandle = Boolean(target.closest('[data-drag-handle]'));
    if (
      !canAddRef.current
      || !graphRef.current
      || event.button !== 0
      || (event.pointerType !== 'mouse' && !isTouchHandle)
      || (target.closest('[data-no-drag]') && !isTouchHandle)
    ) return;

    const additionIndex = roadmapWorkShelfAdditionIndex(result, issue);
    if (additionIndex === undefined) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (isTouchHandle) event.preventDefault();
    updateDrag({
      active: false,
      graphRevision: result.graphRevision,
      issue,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      originX: event.clientX,
      originY: event.clientY,
      overGraph: false,
      planLabel: roadmapWorkShelfPlanLabel(additionIndex),
      planRevision: result.plan.revision,
      width: rect.width,
      x: event.clientX,
      y: event.clientY
    });
  };

  const isDragPending = drag !== null;
  useEffect(() => {
    if (!isDragPending) return;

    const hitTestGraph = (x: number, y: number) => {
      const graph = graphRef.current;
      return Boolean(graph && pointIsInsideElement({ x, y }, graph.getBoundingClientRect()));
    };
    const handleMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const active = current.active || Math.hypot(
        event.clientX - current.originX,
        event.clientY - current.originY
      ) > dragActivationDistance;
      const overGraph = active && hitTestGraph(event.clientX, event.clientY);
      const next = {
        ...current,
        active,
        overGraph,
        x: event.clientX,
        y: event.clientY
      };
      updateDrag(next);
      feedbackRef.current(active ? {
        active: true,
        overGraph,
        planLabel: current.planLabel
      } : null);
    };
    const finishDrag = (commit: boolean, x?: number, y?: number) => {
      const current = dragRef.current;
      if (!current) return;
      const shouldAdd = canAddRef.current
        && current.active
        && current.graphRevision === graphRevisionRef.current
        && current.planRevision === planRevisionRef.current
        && commit
        && x !== undefined
        && y !== undefined
        && hitTestGraph(x, y);
      updateDrag(null);
      feedbackRef.current(null);
      if (shouldAdd) void runAddRef.current(current.issue.number);
    };
    const handleUp = (event: PointerEvent) => finishDrag(true, event.clientX, event.clientY);
    const handleCancel = () => finishDrag(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finishDrag(false);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [graphRef, isDragPending]);

  useEffect(() => {
    if (canAdd || !dragRef.current) return;
    updateDrag(null);
    feedbackRef.current(null);
  }, [canAdd]);

  useEffect(() => {
    const current = dragRef.current;
    if (
      !current
      || (
        current.graphRevision === result.graphRevision
        && current.planRevision === result.plan.revision
      )
    ) return;
    updateDrag(null);
    feedbackRef.current(null);
  }, [result.graphRevision, result.plan.revision]);

  useEffect(() => {
    if (!drag?.active) return;
    document.body.classList.add('issue-dragging');
    return () => document.body.classList.remove('issue-dragging');
  }, [drag?.active]);

  return (
    <section
      aria-label="Unplanned work"
      className="min-w-0 border-t border-neutral-800/80 pt-4"
    >
      <div className="mb-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Text as="h3" className="text-sm font-semibold text-neutral-100">Unplanned work</Text>
            <span className="rounded-full bg-neutral-800 px-2 py-0.5 font-mono text-[10px] tabular-nums text-neutral-400">
              {allUnplannedCount}
            </span>
          </div>
          <Text className="mt-1 block text-xs text-neutral-500">
            Swipe the stack, then drag a handle into the canvas or add with one tap.
          </Text>
        </div>
        <div className="flex min-w-0 items-end gap-2">
          <SearchField
            className="min-w-0 flex-1 sm:w-56 sm:flex-none"
            fullWidth
            name="roadmap-work-shelf-search"
            onChange={setQuery}
            value={query}
            variant="secondary"
          >
            <Label className="sr-only">Search unplanned work</Label>
            <SearchField.Group className="border-neutral-700 bg-neutral-950">
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="Search issues" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
          <span className="hidden shrink-0 overflow-hidden rounded-lg border border-neutral-800 sm:inline-flex">
            <button
              aria-label="Scroll unplanned work left"
              className="grid size-9 place-items-center text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-neutral-200"
              onClick={() => scrollerRef.current?.scrollBy({ behavior: 'smooth', left: -300 })}
              type="button"
            ><ChevronLeft className="size-4" /></button>
            <button
              aria-label="Scroll unplanned work right"
              className="grid size-9 place-items-center border-l border-neutral-800 text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-2 focus-visible:outline-neutral-200"
              onClick={() => scrollerRef.current?.scrollBy({ behavior: 'smooth', left: 300 })}
              type="button"
            ><ChevronRight className="size-4" /></button>
          </span>
        </div>
      </div>

      {error ? (
        <div className="flex min-h-28 items-center justify-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/5 px-4 text-center" role="alert">
          <Text className="text-xs text-rose-200">{error}</Text>
          <Button onPress={onRetry} size="sm" variant="secondary"><RefreshCw className="size-3.5" /> Retry</Button>
        </div>
      ) : isLoading ? (
        <div aria-label="Loading unplanned work" className="flex gap-3 overflow-hidden">
          {[0, 1, 2].map((index) => <div className="h-36 w-64 shrink-0 animate-pulse rounded-xl bg-neutral-900/70" key={index} />)}
        </div>
      ) : shelfIssues.length > 0 ? (
        <div
          className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1 pb-2 sm:snap-proximity"
          ref={scrollerRef}
          tabIndex={0}
        >
          {shelfIssues.map((issue) => {
            const additionIndex = roadmapWorkShelfAdditionIndex(result, issue);
            const planLabel = roadmapWorkShelfPlanLabel(additionIndex);
            const pending = pendingIssueNumber === issue.number;
            return (
              <article
                aria-label={`Issue #${issue.number}: ${issue.title}`}
                className={cn(
                  'group relative flex h-36 w-[min(17rem,calc(100vw-5rem))] shrink-0 snap-start flex-col rounded-xl border border-neutral-800 bg-neutral-950/80 p-3 transition hover:-translate-y-0.5 hover:border-neutral-700 hover:shadow-xl hover:shadow-black/25 [@media(pointer:fine)]:cursor-grab [@media(pointer:fine)]:select-none',
                  drag?.active && drag.issue.number === issue.number && 'opacity-35'
                )}
                key={issue.number}
                onPointerDown={(event) => beginDrag(event, issue)}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'grid size-8 shrink-0 touch-none place-items-center rounded-lg border border-neutral-800 text-neutral-500 transition',
                      canAdd ? 'active:scale-95 group-hover:border-neutral-700 group-hover:text-neutral-300' : 'opacity-40'
                    )}
                    data-drag-handle
                  >
                    <GripVertical className="size-4" />
                  </span>
                  <Text className="font-mono text-[11px] text-neutral-500">#{issue.number}</Text>
                  <span className={cn(
                    'ml-auto inline-flex items-center gap-1 text-[10px]',
                    issue.state === 'closed' ? 'text-neutral-500' : 'text-emerald-400'
                  )}>
                    {issue.state === 'closed'
                      ? <CheckCircle2 className="size-3" />
                      : <CircleDot className="size-3" />}
                    {issue.state === 'closed' ? 'Closed' : 'Open'}
                  </span>
                </div>
                <Text className="mt-2 line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-5 text-neutral-100">
                  {issue.title}
                </Text>
                <div className="mt-auto flex min-w-0 items-center gap-2">
                  <Text className="min-w-0 flex-1 truncate text-[10px] text-neutral-600">
                    {issue.labels[0] ?? 'No label'}
                  </Text>
                  <Button
                    aria-label={`Add issue #${issue.number} as ${planLabel}`}
                    data-no-drag
                    isDisabled={isDisabled || additionIndex === undefined || pending}
                    onPress={() => void runAdd(issue.number)}
                    size="sm"
                    variant="secondary"
                  >
                    {pending ? <RefreshCw className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                    {planLabel}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="flex min-h-28 items-center justify-center rounded-xl border border-dashed border-neutral-800 px-5 text-center">
          <Text className="max-w-sm text-xs text-neutral-500">
            {query ? 'No unplanned issues match this search.' : 'Every loaded issue is already in the roadmap.'}
          </Text>
        </div>
      )}

      {drag?.active ? createPortal(
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-[100]"
          style={{
            transform: `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px) rotate(${drag.overGraph ? -1 : 1.5}deg)`,
            width: drag.width
          }}
        >
          <div className={cn(
            'rounded-xl border bg-neutral-900 p-3 shadow-2xl shadow-black/70 ring-1 transition',
            drag.overGraph
              ? 'border-emerald-400/70 ring-emerald-400/30'
              : 'border-neutral-600 ring-white/10'
          )}>
            <div className="flex items-center gap-2">
              <GripVertical className="size-4 text-neutral-400" />
              <Text className="font-mono text-[11px] text-neutral-500">#{drag.issue.number}</Text>
              <Text className="ml-auto text-[10px] text-emerald-400">{drag.planLabel}</Text>
            </div>
            <Text className="mt-2 line-clamp-2 text-sm font-medium text-neutral-100">{drag.issue.title}</Text>
          </div>
        </div>,
        document.body
      ) : null}
    </section>
  );
}
