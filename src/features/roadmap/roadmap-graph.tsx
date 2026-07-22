import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type EdgeMouseHandler,
  type ReactFlowInstance
} from '@xyflow/react';
import { Focus, Minus, Plus } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import { Button } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { RoadmapIssueNode, RoadmapResult } from '@/shared/roadmap-api';
import { validRoadmapMoveRange } from '@/shared/roadmap-model';
import {
  roadmapGeometricDropTarget,
  roadmapGraphNodeRects,
  type RoadmapGeometricDropTarget
} from './roadmap-drop-geometry';
import { RoadmapDragOverlay, type RoadmapReorderDragState } from './roadmap-drag-overlay';
import { layoutRoadmapGraph } from './roadmap-layout';
import { RoadmapGraphNode } from './roadmap-graph-node';
import {
  pointIsInsideElement,
  roadmapMovePositionLabel
} from './roadmap-work-shelf-model';
import {
  roadmapReactFlowEdges,
  roadmapReactFlowNodes,
  type RoadmapFlowEdge,
  type RoadmapFlowNode
} from './roadmap-react-flow-model';

const nodeTypes = { roadmap: RoadmapGraphNode };
const dragActivationDistance = 6;

export function RoadmapGraph({
  compact = false,
  containerRef,
  dropExclusionRef,
  dropTarget,
  fill = false,
  onSelect,
  onRemove,
  onReorder,
  pendingIssueIds = new Set(),
  result,
  orderingResult = result,
  selectedIssueId,
  withShelf = false
}: {
  compact?: boolean;
  containerRef?: RefObject<HTMLDivElement | null>;
  dropExclusionRef?: RefObject<HTMLElement | null>;
  dropTarget?: {
    active: boolean;
    insertionIndex?: number;
    marker?: RoadmapGeometricDropTarget['marker'];
    overGraph: boolean;
    planLabel: string;
    positionLabel?: string;
  } | null;
  fill?: boolean;
  onSelect(issue: RoadmapIssueNode): void;
  onRemove?(issue: RoadmapIssueNode): Promise<boolean>;
  onReorder?(issue: RoadmapIssueNode, insertionIndex: number): Promise<boolean>;
  orderingResult?: RoadmapResult;
  pendingIssueIds?: ReadonlySet<number>;
  result: RoadmapResult;
  selectedIssueId?: number;
  withShelf?: boolean;
}) {
  const [instance, setInstance] = useState<ReactFlowInstance<
    RoadmapFlowNode,
    RoadmapFlowEdge
  > | null>(null);
  const [reorderDrag, setReorderDrag] = useState<RoadmapReorderDragState | null>(null);
  const reorderDragRef = useRef<RoadmapReorderDragState | null>(null);
  const suppressSelectRef = useRef<{ issueId: number; until: number } | undefined>(undefined);
  const fittedRepositoryRef = useRef<string | undefined>(undefined);
  const knownNodeIdsRef = useRef(new Set<string>());
  const knownNodeRepositoryRef = useRef<string | undefined>(undefined);
  const layout = useMemo(
    () => layoutRoadmapGraph(result.plan, result.issues, result.dependencies, compact),
    [compact, result.dependencies, result.issues, result.plan]
  );
  const beginReorder = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    issue: RoadmapIssueNode
  ) => {
    if (!onReorder || event.button !== 0 || !containerRef?.current) return;
    const target = event.target as HTMLElement;
    const isTouchHandle = Boolean(target.closest('[data-roadmap-reorder-handle]'));
    if (event.pointerType !== 'mouse' && !isTouchHandle) return;
    if (isTouchHandle) event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const next = {
      active: false,
      graphRevision: result.graphRevision,
      issue,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      originX: event.clientX,
      originY: event.clientY,
      overBacklog: false,
      overGraph: false,
      planRevision: result.plan.revision,
      width: rect.width,
      x: event.clientX,
      y: event.clientY
    };
    reorderDragRef.current = next;
    setReorderDrag(next);
  }, [containerRef, onReorder, result.graphRevision, result.plan.revision]);
  const selectIssue = useCallback((issue: RoadmapIssueNode) => {
    const suppressed = suppressSelectRef.current;
    if (suppressed?.issueId === issue.issue.id && suppressed.until > Date.now()) {
      suppressSelectRef.current = undefined;
      return;
    }
    if (suppressed && suppressed.until <= Date.now()) suppressSelectRef.current = undefined;
    onSelect(issue);
  }, [onSelect]);
  const nodes = useMemo(
    () => roadmapReactFlowNodes(
      layout,
      selectedIssueId,
      selectIssue,
      pendingIssueIds,
      onReorder ? beginReorder : undefined,
      reorderDrag?.active ? reorderDrag.issue.issue.id : undefined
    ),
    [beginReorder, layout, onReorder, pendingIssueIds, reorderDrag?.active, reorderDrag?.issue.issue.id, selectIssue, selectedIssueId]
  );
  const issuesById = useMemo(
    () => new Map(result.issues.map((issue) => [issue.issue.id, issue])),
    [result.issues]
  );
  const selectBlockedIssue = useCallback((blockedIssueId: number) => {
    const issue = issuesById.get(blockedIssueId);
    if (issue) onSelect(issue);
  }, [issuesById, onSelect]);
  const edges = useMemo(
    () => roadmapReactFlowEdges(layout, selectBlockedIssue),
    [layout, selectBlockedIssue]
  );
  const selectEdge = useCallback<EdgeMouseHandler<RoadmapFlowEdge>>((_event, edge) => {
    if (edge.data?.blockedIssueId) selectBlockedIssue(edge.data.blockedIssueId);
  }, [selectBlockedIssue]);

  const fit = useCallback(() => {
    void instance?.fitView({
      duration: 420,
      ease: springEase,
      maxZoom: compact ? 0.96 : 1,
      minZoom: compact ? 0.35 : 0.2,
      padding: compact ? 0.08 : 0.12
    });
  }, [compact, instance]);

  const reorderTarget = useCallback((x: number, y: number, issue: RoadmapIssueNode) => {
    const graph = containerRef?.current;
    if (!graph) return undefined;
    const rect = graph.getBoundingClientRect();
    if (!pointIsInsideElement({ x, y }, rect)) return undefined;
    const exclusion = dropExclusionRef?.current?.getBoundingClientRect();
    if (exclusion && pointIsInsideElement({ x, y }, exclusion)) return undefined;
    const bottom = exclusion && exclusion.top > rect.top
      ? Math.min(rect.bottom, exclusion.top)
      : rect.bottom;
    const usableRect = {
      bottom,
      height: Math.max(1, bottom - rect.top),
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width
    };
    if (!pointIsInsideElement({ x, y }, usableRect)) return undefined;
    const range = validRoadmapMoveRange(
      orderingResult.plan.items,
      orderingResult.dependencies,
      issue.issue
    );
    if (!range) return undefined;
    return roadmapGeometricDropTarget({
      graphRect: usableRect,
      nodeRects: roadmapGraphNodeRects(graph, usableRect)
        .filter((node) => node.issueId !== issue.issue.id),
      orderedIssueIds: orderingResult.plan.items
        .map((item) => item.issue.id)
        .filter((issueId) => issueId !== issue.issue.id),
      point: { x, y },
      range
    });
  }, [containerRef, dropExclusionRef, orderingResult]);

  const isOverBacklog = useCallback((x: number, y: number) => {
    const rect = dropExclusionRef?.current?.getBoundingClientRect();
    return Boolean(rect && pointIsInsideElement({ x, y }, rect));
  }, [dropExclusionRef]);

  useEffect(() => {
    fittedRepositoryRef.current = undefined;
  }, [compact]);

  useEffect(() => {
    if (!instance || nodes.length === 0
      || fittedRepositoryRef.current === result.repository.fullName) return;
    fittedRepositoryRef.current = result.repository.fullName;
    const frame = window.requestAnimationFrame(fit);
    return () => window.cancelAnimationFrame(frame);
  }, [fit, instance, nodes.length, result.repository.fullName]);

  useEffect(() => {
    const issueNodes = nodes.filter((node) => node.data.kind === 'issue');
    if (knownNodeRepositoryRef.current !== result.repository.fullName) {
      knownNodeRepositoryRef.current = result.repository.fullName;
      knownNodeIdsRef.current = new Set(issueNodes.map((node) => node.id));
      return;
    }
    const added = issueNodes.filter((node) => !knownNodeIdsRef.current.has(node.id));
    knownNodeIdsRef.current = new Set(issueNodes.map((node) => node.id));
    if (!instance || added.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      void instance.fitView({
        duration: 420,
        maxZoom: 1,
        nodes: added,
        padding: 0.8
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [instance, nodes, result.repository.fullName]);

  useEffect(() => {
    if (!reorderDrag) return;
    const update = (next: RoadmapReorderDragState | null) => {
      reorderDragRef.current = next;
      setReorderDrag(next);
    };
    const finish = (commit: boolean, x?: number, y?: number) => {
      const current = reorderDragRef.current;
      if (!current) return;
      if (current.active) {
        suppressSelectRef.current = {
          issueId: current.issue.issue.id,
          until: Date.now() + 250
        };
      }
      const target = x === undefined || y === undefined
        ? undefined
        : reorderTarget(x, y, current.issue);
      const overBacklog = x !== undefined && y !== undefined && isOverBacklog(x, y);
      const validRevision = commit
        && current.active
        && current.graphRevision === result.graphRevision
        && current.planRevision === result.plan.revision;
      update(null);
      if (validRevision && overBacklog && onRemove) {
        void onRemove(current.issue);
      } else if (validRevision && target) {
        void onReorder?.(current.issue, target.insertionIndex);
      }
    };
    const handleMove = (event: PointerEvent) => {
      const current = reorderDragRef.current;
      if (!current) return;
      const active = current.active || Math.hypot(
        event.clientX - current.originX,
        event.clientY - current.originY
      ) > dragActivationDistance;
      if (active && !current.active) {
        suppressSelectRef.current = {
          issueId: current.issue.issue.id,
          until: Number.POSITIVE_INFINITY
        };
      }
      const overBacklog = active && isOverBacklog(event.clientX, event.clientY);
      const target = active && !overBacklog
        ? reorderTarget(event.clientX, event.clientY, current.issue)
        : undefined;
      update({
        ...current,
        active,
        overBacklog,
        overGraph: target !== undefined,
        target,
        x: event.clientX,
        y: event.clientY
      });
    };
    const handleUp = (event: PointerEvent) => finish(true, event.clientX, event.clientY);
    const handleCancel = () => finish(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
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
  }, [isOverBacklog, onRemove, onReorder, reorderDrag, reorderTarget, result.graphRevision, result.plan.revision]);

  useEffect(() => {
    if (!reorderDrag?.active) return;
    document.body.classList.add('issue-dragging');
    return () => document.body.classList.remove('issue-dragging');
  }, [reorderDrag?.active]);

  const effectiveDropTarget = reorderDrag?.active ? {
    active: true,
    insertionIndex: reorderDrag.target?.insertionIndex,
    marker: reorderDrag.target?.marker,
    overGraph: reorderDrag.overGraph,
    planLabel: reorderDrag.target === undefined
      ? 'manual plan order'
      : roadmapMovePositionLabel(orderingResult, reorderDrag.issue.issue, reorderDrag.target.insertionIndex),
    positionLabel: reorderDrag.target === undefined
      ? undefined
      : roadmapMovePositionLabel(orderingResult, reorderDrag.issue.issue, reorderDrag.target.insertionIndex)
  } : dropTarget;

  return (
    <div
      aria-label="Roadmap dependency graph"
      className={cn(
        'relative min-w-0 overflow-hidden rounded-2xl border border-dashed bg-neutral-950/35 transition-colors',
        fill
          ? 'h-full min-h-0 rounded-xl'
          : withShelf
          ? 'h-[min(58dvh,36rem)] min-h-[28rem] max-md:h-[26rem] max-md:min-h-[24rem]'
          : 'h-[min(68dvh,42rem)] min-h-[32rem] max-md:h-[34rem] max-md:min-h-[30rem]',
        effectiveDropTarget?.active
          ? effectiveDropTarget.overGraph
            ? 'border-emerald-400/80 bg-emerald-500/[0.04]'
            : 'border-neutral-500'
          : 'border-neutral-700/90'
      )}
      data-testid="roadmap-graph"
      ref={containerRef}
    >
      <ReactFlow<RoadmapFlowNode, RoadmapFlowEdge>
        autoPanOnConnect={false}
        autoPanOnNodeDrag={false}
        colorMode="dark"
        connectOnClick={false}
        deleteKeyCode={null}
        edges={edges}
        edgesFocusable
        edgesReconnectable={false}
        elementsSelectable
        elevateEdgesOnSelect
        fitView
        maxZoom={1.5}
        minZoom={compact ? 0.35 : 0.2}
        multiSelectionKeyCode={null}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodesFocusable={false}
        onEdgeClick={selectEdge}
        onInit={setInstance}
        panOnDrag
        panOnScroll={!compact}
        preventScrolling
        proOptions={{ hideAttribution: true }}
        selectionKeyCode={null}
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
        zoomOnPinch
        zoomOnScroll={!compact}
      >
        <Background
          color="rgb(64 64 64)"
          gap={18}
          size={1}
          variant={BackgroundVariant.Dots}
        />
      </ReactFlow>
      <div className={cn('absolute left-3 z-10 flex items-center gap-2', fill ? 'top-3' : 'bottom-3')}>
        <Button aria-label="Fit roadmap graph" onPress={fit} size="sm" variant="secondary">
          <Focus className="size-3.5" /> Fit
        </Button>
        <span className="inline-flex overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900/95">
          <button
            aria-label="Zoom out"
            className="grid size-9 place-items-center text-neutral-300 transition hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-neutral-200"
            onClick={() => void instance?.zoomOut({ duration: 260 })}
            type="button"
          ><Minus className="size-3.5" /></button>
          <button
            aria-label="Zoom in"
            className="grid size-9 place-items-center border-l border-neutral-700 text-neutral-300 transition hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-neutral-200"
            onClick={() => void instance?.zoomIn({ duration: 260 })}
            type="button"
          ><Plus className="size-3.5" /></button>
        </span>
      </div>
      {effectiveDropTarget?.active ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-end p-4">
          <div className={cn(
            'mx-auto rounded-full border px-4 py-2 text-center text-xs font-semibold shadow-xl backdrop-blur transition-all',
            effectiveDropTarget.overGraph
              ? 'translate-y-0 border-emerald-400/50 bg-emerald-500/20 text-emerald-100 shadow-emerald-950/40'
              : 'translate-y-1 border-neutral-700 bg-neutral-950/90 text-neutral-300 shadow-black/40'
          )}>
            {reorderDrag?.overBacklog
              ? 'Release to return to unplanned work'
              : effectiveDropTarget.overGraph
              ? `Release at ${effectiveDropTarget.positionLabel ?? effectiveDropTarget.planLabel}`
              : 'Drop into the open canvas'}
          </div>
        </div>
      ) : null}
      {effectiveDropTarget?.active && effectiveDropTarget.overGraph && effectiveDropTarget.marker ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-20 border-l-2 border-dashed border-emerald-300/90"
          style={{
            height: effectiveDropTarget.marker.height,
            left: effectiveDropTarget.marker.left,
            top: effectiveDropTarget.marker.top
          }}
        >
          <span className={cn(
            'absolute top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full border border-emerald-300/60 bg-emerald-500/25 px-2 py-1 text-[10px] font-semibold text-emerald-50 shadow-lg backdrop-blur',
            effectiveDropTarget.marker.labelSide === 'right' ? 'left-2' : 'right-2'
          )}>
            {effectiveDropTarget.positionLabel ?? effectiveDropTarget.planLabel}
          </span>
        </div>
      ) : null}
      <p className="sr-only">
        Dependency arrows run from prerequisites to the issues they unlock. Plan badges show a separate manual order.
      </p>
      <RoadmapDragOverlay
        backlogElement={dropExclusionRef?.current}
        drag={reorderDrag?.active ? reorderDrag : null}
        orderingResult={orderingResult}
      />
    </div>
  );
}

function springEase(progress: number) {
  const damping = Math.exp(-6 * progress);
  return Math.min(1, 1 - damping * Math.cos(8 * progress));
}
