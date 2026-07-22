import {
  MarkerType,
  type Edge,
  type Node
} from '@xyflow/react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { roadmapIssueKey } from '../../shared/roadmap-model';
import type {
  RoadmapLayout,
  RoadmapLayoutGroup,
  RoadmapLayoutNode
} from './roadmap-layout';
import type { RoadmapIssueNode } from '../../shared/roadmap-api';
import { roadmapNodeId } from './roadmap-layout';

export type RoadmapFlowNodeData = (
  | { kind: 'goal'; layoutGroup: RoadmapLayoutGroup }
  | {
      kind: 'issue';
      layoutNode: RoadmapLayoutNode;
      onReorderStart?: (event: ReactPointerEvent<HTMLElement>, issue: RoadmapIssueNode) => void;
      onSelect?: (issue: RoadmapIssueNode) => void;
      pending?: boolean;
    }
) & Record<string, unknown>;

export type RoadmapFlowNode = Node<RoadmapFlowNodeData, 'roadmap'>;
export type RoadmapFlowEdge = Edge<{
  blockedIssueId: number;
  blockerIssueId: number;
}>;

export function roadmapReactFlowNodes(
  layout: RoadmapLayout,
  selectedIssueId?: number,
  onSelect?: (issue: RoadmapIssueNode) => void,
  pendingIssueIds: ReadonlySet<number> = new Set(),
  onReorderStart?: (event: ReactPointerEvent<HTMLElement>, issue: RoadmapIssueNode) => void
): RoadmapFlowNode[] {
  const groups = layout.groups.map<RoadmapFlowNode>((layoutGroup) => ({
    ariaLabel: `Goal: ${layoutGroup.goal.title}`,
    connectable: false,
    data: { kind: 'goal', layoutGroup },
    deletable: false,
    draggable: false,
    focusable: false,
    height: layoutGroup.dimensions.height,
    id: layoutGroup.id,
    position: layoutGroup.position,
    selectable: false,
    style: layoutGroup.dimensions,
    type: 'roadmap',
    width: layoutGroup.dimensions.width,
    zIndex: 0
  }));
  const issues = layout.nodes.map<RoadmapFlowNode>((layoutNode) => ({
    ariaLabel: issueActivationLabel(layoutNode),
    connectable: false,
    data: {
      kind: 'issue',
      layoutNode,
      onReorderStart,
      onSelect,
      pending: pendingIssueIds.has(layoutNode.issue.issue.id)
    },
    deletable: false,
    draggable: false,
    focusable: false,
    height: layoutNode.dimensions.height,
    id: layoutNode.id,
    position: layoutNode.position,
    selectable: true,
    selected: layoutNode.issue.issue.id === selectedIssueId,
    style: layoutNode.dimensions,
    type: 'roadmap',
    width: layoutNode.dimensions.width,
    zIndex: 2
  }));
  return [...groups, ...issues];
}

export function roadmapReactFlowEdges(
  layout: RoadmapLayout,
  onActivate?: (blockedIssueId: number) => void
): RoadmapFlowEdge[] {
  return layout.edges.map((dependency) => {
    const stale = dependency.freshness === 'stale';
    return {
      ariaLabel: `Dependency: #${dependency.blocker.number} unlocks #${dependency.blocked.number}`,
      ariaRole: 'button',
      data: {
        blockedIssueId: dependency.blocked.id,
        blockerIssueId: dependency.blocker.id
      },
      deletable: false,
      domAttributes: {
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onActivate?.(dependency.blocked.id);
        }
      },
      focusable: true,
      id: `roadmap:edge:${roadmapIssueKey(dependency.blocker)}:${roadmapIssueKey(dependency.blocked)}`,
      markerEnd: {
        color: stale ? 'rgb(56 189 248)' : 'rgb(163 163 163)',
        height: 16,
        type: MarkerType.ArrowClosed,
        width: 16
      },
      reconnectable: false,
      selectable: true,
      source: roadmapNodeId(dependency.blocker.id),
      style: {
        stroke: stale ? 'rgb(56 189 248)' : 'rgb(115 115 115)',
        strokeDasharray: stale ? '5 5' : undefined,
        strokeWidth: 1.5
      },
      target: roadmapNodeId(dependency.blocked.id),
      type: 'smoothstep'
    };
  });
}

function issueActivationLabel(node: RoadmapLayoutNode) {
  const parts = [
    `Inspect ${node.issue.issue.fullName} issue #${node.issue.issue.number}`,
    node.issue.title,
    node.issue.availability
  ];
  if (node.planPosition) parts.push(`plan ${node.planPosition}`);
  if (node.isRoot) parts.push('root');
  if (node.isTerminal) parts.push('terminal branch');
  return parts.join(', ');
}
