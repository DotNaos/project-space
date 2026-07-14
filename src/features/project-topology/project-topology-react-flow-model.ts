import type { ReactNode } from 'react';
import type { Edge, Node, Viewport } from '@xyflow/react';
import type {
  ProjectTopologyLayout,
  TopologyBounds,
  TopologyFocusTarget,
  TopologyLayoutNode,
  TopologySize
} from './project-topology-layout';
import type { ProjectTopologySnapshot } from './project-topology-types';

export interface TopologyReactFlowNodeData extends Record<string, unknown> {
  activationLabel: string;
  content: ReactNode;
  layoutNode: TopologyLayoutNode;
}

export type TopologyReactFlowNode = Node<TopologyReactFlowNodeData, 'topology'>;
export type TopologyReactFlowEdge = Edge<Record<string, never>>;
const nativeOverviewTopInset = 76;

export interface TopologyViewportRequest {
  bounds: TopologyBounds;
  kind: 'fit-bounds' | 'native-top';
  target: TopologyFocusTarget;
  transition: number;
  zoom?: number;
}

export function topologyReactFlowNodes(
  layout: ProjectTopologyLayout,
  snapshot: ProjectTopologySnapshot,
  renderNode: (node: TopologyLayoutNode) => ReactNode
): TopologyReactFlowNode[] {
  return layout.nodes.map((layoutNode) => {
    const activationLabel = topologyNodeActivationLabel(layoutNode, snapshot);
    return {
      ariaLabel: activationLabel,
      connectable: false,
      data: { activationLabel, content: renderNode(layoutNode), layoutNode },
      deletable: false,
      draggable: false,
      expandParent: false,
      extent: layoutNode.parentId ? 'parent' : undefined,
      focusable: false,
      height: layoutNode.dimensions.height,
      id: layoutNode.id,
      initialHeight: layoutNode.dimensions.height,
      initialWidth: layoutNode.dimensions.width,
      parentId: layoutNode.parentId,
      position: layoutNode.position,
      selectable: false,
      style: {
        height: layoutNode.dimensions.height,
        width: layoutNode.dimensions.width
      },
      type: 'topology',
      width: layoutNode.dimensions.width,
      zIndex: topologyNodeLayer(layoutNode)
    };
  });
}

export function topologyReactFlowEdges(
  layout: ProjectTopologyLayout
): TopologyReactFlowEdge[] {
  return layout.edges.map((edge) => ({
    ...edge,
    data: {},
    deletable: false,
    focusable: false,
    reconnectable: false,
    selectable: false,
    style: { stroke: 'rgb(82 82 91)', strokeWidth: 1.25 },
    type: 'smoothstep'
  }));
}

export function visibleTopologyTaskIds(
  layout: ProjectTopologyLayout,
  viewport: Viewport,
  viewportSize: TopologySize
): string[] {
  if (!isFinitePositive(viewport.zoom)
    || !isFinitePositive(viewportSize.width)
    || !isFinitePositive(viewportSize.height)) {
    return [];
  }
  return layout.nodes.flatMap((node) => {
    if (node.kind !== 'task') return [];
    const left = node.absolutePosition.x * viewport.zoom + viewport.x;
    const top = node.absolutePosition.y * viewport.zoom + viewport.y;
    const right = left + node.dimensions.width * viewport.zoom;
    const bottom = top + node.dimensions.height * viewport.zoom;
    return right > 0
      && bottom > 0
      && left < viewportSize.width
      && top < viewportSize.height
        ? [node.taskId]
        : [];
  });
}

export function topologyViewportRequest(viewport: {
  bounds: TopologyBounds;
  overview: ProjectTopologyLayout['overviewViewport'];
  target: TopologyFocusTarget;
  transition: number;
}): TopologyViewportRequest {
  if (viewport.target.kind === 'overview' && viewport.overview.mode === 'native-pan') {
    return {
      bounds: viewport.bounds,
      kind: 'native-top',
      target: viewport.target,
      transition: viewport.transition,
      zoom: viewport.overview.zoom
    };
  }
  return {
    bounds: viewport.bounds,
    kind: 'fit-bounds',
    target: viewport.target,
    transition: viewport.transition
  };
}

export function topologyNativePanViewport(
  request: Pick<TopologyViewportRequest, 'bounds' | 'zoom'>,
  viewportSize: TopologySize
): Viewport {
  const zoom = request.zoom ?? 1;
  return {
    x: viewportSize.width / 2
      - (request.bounds.x + request.bounds.width / 2) * zoom,
    y: nativeOverviewTopInset - request.bounds.y * zoom,
    zoom
  };
}

export function sameTopologyViewportRequest(
  left: Pick<TopologyViewportRequest, 'target' | 'transition'>,
  right: Pick<TopologyViewportRequest, 'target' | 'transition'>
) {
  return left.transition === right.transition && sameFocusTarget(left.target, right.target);
}

function topologyNodeActivationLabel(
  node: TopologyLayoutNode,
  snapshot: ProjectTopologySnapshot
) {
  if (node.kind === 'lead') return `Open ${snapshot.lead.label} conversation`;
  const project = snapshot.projects.find((candidate) => candidate.id === node.projectId);
  if (node.kind === 'project') return `Focus ${project?.name ?? 'project'}`;
  const machine = project?.machines.find((candidate) => candidate.id === node.machineId);
  if (node.kind === 'machine') return `Focus ${machine?.name ?? 'machine'}`;
  const task = machine?.tasks.find((candidate) => candidate.id === node.taskId);
  const label = task?.issue ? `#${task.issue.number} ${task.issue.title}` : task?.title ?? 'task';
  return `Open ${label} command center`;
}

function topologyNodeLayer(node: TopologyLayoutNode) {
  if (node.kind === 'lead') return 3;
  if (node.kind === 'task') return 2;
  if (node.kind === 'machine') return 1;
  return 0;
}

function sameFocusTarget(left: TopologyFocusTarget, right: TopologyFocusTarget) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'overview' && right.kind === 'overview') return true;
  if (left.kind === 'project' && right.kind === 'project') {
    return left.projectId === right.projectId;
  }
  if (left.kind === 'machine' && right.kind === 'machine') {
    return left.projectId === right.projectId && left.machineId === right.machineId;
  }
  return left.kind === 'task'
    && right.kind === 'task'
    && left.taskId === right.taskId;
}

function isFinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}
