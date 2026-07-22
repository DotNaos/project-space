import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
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
import { layoutRoadmapGraph } from './roadmap-layout';
import { RoadmapGraphNode } from './roadmap-graph-node';
import {
  roadmapReactFlowEdges,
  roadmapReactFlowNodes,
  type RoadmapFlowEdge,
  type RoadmapFlowNode
} from './roadmap-react-flow-model';

const nodeTypes = { roadmap: RoadmapGraphNode };

export function RoadmapGraph({
  compact = false,
  containerRef,
  dropTarget,
  onSelect,
  result,
  selectedIssueId,
  withShelf = false
}: {
  compact?: boolean;
  containerRef?: RefObject<HTMLDivElement | null>;
  dropTarget?: { active: boolean; overGraph: boolean; planLabel: string } | null;
  onSelect(issue: RoadmapIssueNode): void;
  result: RoadmapResult;
  selectedIssueId?: number;
  withShelf?: boolean;
}) {
  const [instance, setInstance] = useState<ReactFlowInstance<
    RoadmapFlowNode,
    RoadmapFlowEdge
  > | null>(null);
  const layout = useMemo(
    () => layoutRoadmapGraph(result.plan, result.issues, result.dependencies, compact),
    [compact, result.dependencies, result.issues, result.plan]
  );
  const nodes = useMemo(
    () => roadmapReactFlowNodes(layout, selectedIssueId, onSelect),
    [layout, onSelect, selectedIssueId]
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

  useEffect(() => {
    if (!instance || nodes.length === 0) return;
    const frame = window.requestAnimationFrame(fit);
    return () => window.cancelAnimationFrame(frame);
  }, [fit, instance, layout.bounds.height, layout.bounds.width, nodes.length]);

  return (
    <div
      aria-label="Roadmap dependency graph"
      className={cn(
        'relative min-w-0 overflow-hidden rounded-2xl border border-dashed bg-neutral-950/35 transition-colors',
        withShelf
          ? 'h-[min(58dvh,36rem)] min-h-[28rem] max-md:h-[26rem] max-md:min-h-[24rem]'
          : 'h-[min(68dvh,42rem)] min-h-[32rem] max-md:h-[34rem] max-md:min-h-[30rem]',
        dropTarget?.active
          ? dropTarget.overGraph
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
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2">
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
      {dropTarget?.active ? (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-end p-4">
          <div className={cn(
            'mx-auto rounded-full border px-4 py-2 text-center text-xs font-semibold shadow-xl backdrop-blur transition-all',
            dropTarget.overGraph
              ? 'translate-y-0 border-emerald-400/50 bg-emerald-500/20 text-emerald-100 shadow-emerald-950/40'
              : 'translate-y-1 border-neutral-700 bg-neutral-950/90 text-neutral-300 shadow-black/40'
          )}>
            {dropTarget.overGraph
              ? `Release to add as ${dropTarget.planLabel}`
              : `Drop into the canvas as ${dropTarget.planLabel}`}
          </div>
        </div>
      ) : null}
      <p className="sr-only">
        Dependency arrows run from prerequisites to the issues they unlock. Plan badges show a separate manual order.
      </p>
    </div>
  );
}

function springEase(progress: number) {
  const damping = Math.exp(-6 * progress);
  return Math.min(1, 1 - damping * Math.cos(8 * progress));
}
