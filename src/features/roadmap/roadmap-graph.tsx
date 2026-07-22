import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react';
import { createPortal } from 'react-dom';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type EdgeMouseHandler,
  type ReactFlowInstance
} from '@xyflow/react';
import { Focus, GripVertical, Minus, Plus } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { RoadmapIssueNode, RoadmapResult } from '@/shared/roadmap-api';
import { layoutRoadmapGraph } from './roadmap-layout';
import { RoadmapGraphNode } from './roadmap-graph-node';
import {
  pointIsInsideElement,
  roadmapMovePositionLabel,
  roadmapSpatialMoveIndex
} from './roadmap-work-shelf-model';
import {
  roadmapReactFlowEdges,
  roadmapReactFlowNodes,
  type RoadmapFlowEdge,
  type RoadmapFlowNode
} from './roadmap-react-flow-model';

const nodeTypes = { roadmap: RoadmapGraphNode };
const dragActivationDistance = 6;

interface ReorderDragState {
  active: boolean;
  graphRevision: string;
  issue: RoadmapIssueNode;
  originX: number;
  originY: number;
  overGraph: boolean;
  planRevision: number;
  targetIndex?: number;
  x: number;
  y: number;
}

export function RoadmapGraph({
  compact = false,
  containerRef,
  dropExclusionRef,
  dropTarget,
  fill = false,
  onSelect,
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
  dropTarget?: { active: boolean; insertionIndex?: number; overGraph: boolean; planLabel: string; positionLabel?: string } | null;
  fill?: boolean;
  onSelect(issue: RoadmapIssueNode): void;
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
  const [reorderDrag, setReorderDrag] = useState<ReorderDragState | null>(null);
  const reorderDragRef = useRef<ReorderDragState | null>(null);
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
    const next = {
      active: false,
      graphRevision: result.graphRevision,
      issue,
      originX: event.clientX,
      originY: event.clientY,
      overGraph: false,
      planRevision: result.plan.revision,
      x: event.clientX,
      y: event.clientY
    };
    reorderDragRef.current = next;
    setReorderDrag(next);
  }, [containerRef, onReorder, result.graphRevision, result.plan.revision]);
  const nodes = useMemo(
    () => roadmapReactFlowNodes(
      layout,
      selectedIssueId,
      onSelect,
      pendingIssueIds,
      onReorder ? beginReorder : undefined
    ),
    [beginReorder, layout, onReorder, onSelect, pendingIssueIds, selectedIssueId]
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
    const usableBottom = exclusion && exclusion.top > rect.top
      ? Math.min(rect.bottom, exclusion.top)
      : rect.bottom;
    if (y > usableBottom) return undefined;
    return roadmapSpatialMoveIndex(
      orderingResult,
      issue.issue,
      (y - rect.top) / Math.max(1, usableBottom - rect.top)
    );
  }, [containerRef, dropExclusionRef, orderingResult]);

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
    const update = (next: ReorderDragState | null) => {
      reorderDragRef.current = next;
      setReorderDrag(next);
    };
    const finish = (commit: boolean, x?: number, y?: number) => {
      const current = reorderDragRef.current;
      if (!current) return;
      const targetIndex = x === undefined || y === undefined
        ? undefined
        : reorderTarget(x, y, current.issue);
      const valid = commit
        && current.active
        && targetIndex !== undefined
        && current.graphRevision === result.graphRevision
        && current.planRevision === result.plan.revision;
      update(null);
      if (valid) void onReorder?.(current.issue, targetIndex);
    };
    const handleMove = (event: PointerEvent) => {
      const current = reorderDragRef.current;
      if (!current) return;
      const active = current.active || Math.hypot(
        event.clientX - current.originX,
        event.clientY - current.originY
      ) > dragActivationDistance;
      const targetIndex = active
        ? reorderTarget(event.clientX, event.clientY, current.issue)
        : undefined;
      update({
        ...current,
        active,
        overGraph: targetIndex !== undefined,
        targetIndex,
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
  }, [onReorder, reorderDrag, reorderTarget, result.graphRevision, result.plan.revision]);

  useEffect(() => {
    if (!reorderDrag?.active) return;
    document.body.classList.add('issue-dragging');
    return () => document.body.classList.remove('issue-dragging');
  }, [reorderDrag?.active]);

  const effectiveDropTarget = reorderDrag?.active ? {
    active: true,
    insertionIndex: reorderDrag.targetIndex,
    overGraph: reorderDrag.overGraph,
    planLabel: reorderDrag.targetIndex === undefined
      ? 'manual plan order'
      : roadmapMovePositionLabel(orderingResult, reorderDrag.issue.issue, reorderDrag.targetIndex),
    positionLabel: reorderDrag.targetIndex === undefined
      ? undefined
      : roadmapMovePositionLabel(orderingResult, reorderDrag.issue.issue, reorderDrag.targetIndex)
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
            {effectiveDropTarget.overGraph
              ? `Release at ${effectiveDropTarget.positionLabel ?? effectiveDropTarget.planLabel}`
              : 'Drop into the open canvas'}
          </div>
        </div>
      ) : null}
      {effectiveDropTarget?.active && effectiveDropTarget.overGraph && effectiveDropTarget.insertionIndex !== undefined ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-4 z-20 flex items-center gap-3"
          style={{ top: `${Math.max(4, Math.min(94, (effectiveDropTarget.insertionIndex / Math.max(1, result.plan.items.length)) * 90 + 4))}%` }}
        >
          <span className="rounded-full border border-emerald-300/60 bg-emerald-500/25 px-2 py-1 text-[10px] font-semibold text-emerald-50 shadow-lg">
            {effectiveDropTarget.positionLabel ?? effectiveDropTarget.planLabel}
          </span>
          <span className="h-px flex-1 border-t border-dashed border-emerald-300/80" />
        </div>
      ) : null}
      <p className="sr-only">
        Dependency arrows run from prerequisites to the issues they unlock. Plan badges show a separate manual order.
      </p>
      {reorderDrag?.active ? createPortal(
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-[100] w-64 -translate-x-1/2 -translate-y-1/2"
          style={{ transform: `translate(${reorderDrag.x}px, ${reorderDrag.y}px) translate(-50%, -50%) rotate(-1deg)` }}
        >
          <div className="rounded-xl border border-emerald-400/60 bg-neutral-950/95 p-3 shadow-2xl shadow-black/70 ring-1 ring-emerald-400/20">
            <div className="flex items-center gap-2">
              <GripVertical className="size-4 text-emerald-300" />
              <Text className="font-mono text-[11px] text-neutral-400">#{reorderDrag.issue.issue.number}</Text>
              <Text className="ml-auto text-[10px] text-emerald-300">
                {reorderDrag.targetIndex === undefined
                  ? 'Move in canvas'
                  : roadmapMovePositionLabel(orderingResult, reorderDrag.issue.issue, reorderDrag.targetIndex)}
              </Text>
            </div>
            <Text className="mt-1 line-clamp-2 text-sm font-medium text-neutral-100">{reorderDrag.issue.title}</Text>
          </div>
        </div>,
        document.body
      ) : null}
    </div>
  );
}

function springEase(progress: number) {
  const damping = Math.exp(-6 * progress);
  return Math.min(1, 1 - damping * Math.cos(8 * progress));
}
