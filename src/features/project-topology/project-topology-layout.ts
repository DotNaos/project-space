import type { ProjectTopologySnapshot, TopologyMachine, TopologyProject } from './project-topology-types';

export const topologyDimensions = {
  leadHeight: 64,
  leadWidth: 200,
  machineGap: 14,
  machineHeaderHeight: 48,
  machinePadding: 10,
  machineStatusRowHeight: 32,
  machineWidth: 424,
  portfolioTop: 128,
  projectGap: 72,
  projectHeaderHeight: 56,
  projectPadding: 10,
  projectWidth: 444,
  taskGap: 12,
  taskHeight: 170,
  taskWidth: 404
} as const;

const minimumReadableOverviewZoom = 0.72;
const compactViewportWidth = 640;
const desktopOverviewProjectCount = 3;

export type TopologyLayoutNode =
  | TopologyLeadLayoutNode
  | TopologyProjectLayoutNode
  | TopologyMachineLayoutNode
  | TopologyTaskLayoutNode;

interface LayoutNodeBase {
  absolutePosition: TopologyPoint;
  dimensions: TopologySize;
  id: string;
  parentId?: string;
  position: TopologyPoint;
}

export interface TopologyLeadLayoutNode extends LayoutNodeBase {
  kind: 'lead';
}

export interface TopologyProjectLayoutNode extends LayoutNodeBase {
  kind: 'project';
  projectId: string;
}

export interface TopologyMachineLayoutNode extends LayoutNodeBase {
  kind: 'machine';
  machineId: string;
  projectId: string;
}

export interface TopologyTaskLayoutNode extends LayoutNodeBase {
  kind: 'task';
  machineId: string;
  projectId: string;
  taskId: string;
}

export interface TopologyPoint {
  x: number;
  y: number;
}

export interface TopologySize {
  height: number;
  width: number;
}

export interface TopologyBounds extends TopologyPoint, TopologySize {}

export interface ProjectTopologyLayout {
  bounds: TopologyBounds;
  edges: Array<{ id: string; source: string; target: string }>;
  nodes: TopologyLayoutNode[];
  overviewViewport:
    | { mode: 'fit' }
    | { anchorX: number; mode: 'native-pan'; zoom: number };
}

export type TopologyFocusTarget =
  | { kind: 'overview' }
  | { kind: 'project'; projectId: string }
  | { kind: 'machine'; machineId: string; projectId: string }
  | { kind: 'task'; taskId: string };

export function layoutProjectTopology(
  snapshot: ProjectTopologySnapshot,
  viewportWidth: number,
  viewportHeight = Number.POSITIVE_INFINITY
): ProjectTopologyLayout {
  const projects = snapshot.projects.map((project) => ({
    height: projectHeight(project),
    project
  }));
  const contentWidth = Math.max(topologyDimensions.leadWidth, rowWidth(projects.length));
  const xOffset = (contentWidth - rowWidth(projects.length)) / 2;
  const overviewAnchorX = projects.length === 0
    ? contentWidth / 2
    : xOffset
      + Math.floor(projects.length / 2) * (
        topologyDimensions.projectWidth + topologyDimensions.projectGap
      )
      + topologyDimensions.projectWidth / 2;
  const nodes: TopologyLayoutNode[] = [];
  const edges: ProjectTopologyLayout['edges'] = [];
  const leadId = 'topology:lead';
  const leadX = overviewAnchorX - topologyDimensions.leadWidth / 2;
  nodes.push({
    absolutePosition: { x: leadX, y: 0 },
    dimensions: {
      height: topologyDimensions.leadHeight,
      width: topologyDimensions.leadWidth
    },
    id: leadId,
    kind: 'lead',
    position: { x: leadX, y: 0 }
  });

  projects.forEach(({ height, project }, projectIndex) => {
    const x = xOffset + projectIndex * (
      topologyDimensions.projectWidth + topologyDimensions.projectGap
    );
    appendProject(nodes, project, { x, y: topologyDimensions.portfolioTop }, height);
    edges.push({
      id: `edge:${leadId}:${projectNodeId(project.id)}`,
      source: leadId,
      target: projectNodeId(project.id)
    });
  });

  const height = projects.length === 0
    ? topologyDimensions.leadHeight
    : topologyDimensions.portfolioTop + Math.max(...projects.map(({ height }) => height));
  const fitZoom = Math.min(
    viewportWidth / Math.max(contentWidth, 1),
    viewportHeight / Math.max(height, 1),
    1
  );
  const readablePanZoom = readableOverviewPanZoom(viewportWidth, contentWidth);
  return {
    bounds: { height, width: contentWidth, x: 0, y: 0 },
    edges,
    nodes,
    overviewViewport: viewportWidth >= compactViewportWidth
      && fitZoom >= minimumReadableOverviewZoom
        ? { mode: 'fit' }
        : { anchorX: overviewAnchorX, mode: 'native-pan', zoom: readablePanZoom }
  };
}

function readableOverviewPanZoom(viewportWidth: number, contentWidth: number) {
  const targetWidth = viewportWidth >= compactViewportWidth
    ? Math.min(contentWidth, rowWidth(desktopOverviewProjectCount))
    : topologyDimensions.projectWidth;
  const horizontalInset = viewportWidth >= compactViewportWidth ? 32 : 16;
  return Math.min(1, Math.max(
    minimumReadableOverviewZoom,
    (viewportWidth - horizontalInset) / Math.max(targetWidth, 1)
  ));
}

export function topologyFocusBounds(
  layout: ProjectTopologyLayout,
  target: TopologyFocusTarget
): TopologyBounds | undefined {
  if (target.kind === 'overview') return layout.bounds;
  const node = layout.nodes.find((candidate) => {
    if (target.kind === 'project') {
      return candidate.kind === 'project' && candidate.projectId === target.projectId;
    }
    if (target.kind === 'machine') {
      return candidate.kind === 'machine'
        && candidate.machineId === target.machineId
        && candidate.projectId === target.projectId;
    }
    return candidate.kind === 'task' && candidate.taskId === target.taskId;
  });
  return node ? { ...node.absolutePosition, ...node.dimensions } : undefined;
}

export function projectNodeId(projectId: string) {
  return `topology:project:${encodeURIComponent(projectId)}`;
}

export function machineNodeId(projectId: string, machineId: string) {
  return `${projectNodeId(projectId)}:machine:${encodeURIComponent(machineId)}`;
}

export function taskNodeId(taskId: string) {
  return `topology:${taskId}`;
}

function appendProject(
  nodes: TopologyLayoutNode[],
  project: TopologyProject,
  position: TopologyPoint,
  height: number
) {
  const projectId = projectNodeId(project.id);
  nodes.push({
    absolutePosition: position,
    dimensions: { height, width: topologyDimensions.projectWidth },
    id: projectId,
    kind: 'project',
    position,
    projectId: project.id
  });
  let machineY = topologyDimensions.projectHeaderHeight + topologyDimensions.projectPadding;
  project.machines.forEach((machine) => {
    const height = machineHeight(machine);
    appendMachine(nodes, project, machine, projectId, { x: topologyDimensions.projectPadding, y: machineY }, {
      x: position.x + topologyDimensions.projectPadding,
      y: position.y + machineY
    }, height);
    machineY += height + topologyDimensions.machineGap;
  });
}

function appendMachine(
  nodes: TopologyLayoutNode[],
  project: TopologyProject,
  machine: TopologyMachine,
  parentId: string,
  position: TopologyPoint,
  absolutePosition: TopologyPoint,
  height: number
) {
  const id = machineNodeId(project.id, machine.id);
  nodes.push({
    absolutePosition,
    dimensions: { height, width: topologyDimensions.machineWidth },
    id,
    kind: 'machine',
    machineId: machine.id,
    parentId,
    position,
    projectId: project.id
  });
  let taskY = topologyDimensions.machineHeaderHeight + topologyDimensions.machinePadding;
  machine.tasks.forEach((task) => {
    const taskPosition = { x: topologyDimensions.machinePadding, y: taskY };
    nodes.push({
      absolutePosition: {
        x: absolutePosition.x + taskPosition.x,
        y: absolutePosition.y + taskPosition.y
      },
      dimensions: { height: topologyDimensions.taskHeight, width: topologyDimensions.taskWidth },
      id: taskNodeId(task.id),
      kind: 'task',
      machineId: machine.id,
      parentId: id,
      position: taskPosition,
      projectId: project.id,
      taskId: task.id
    });
    taskY += topologyDimensions.taskHeight + topologyDimensions.taskGap;
  });
}

function projectHeight(project: TopologyProject) {
  if (project.machines.length === 0) {
    return topologyDimensions.projectHeaderHeight + topologyDimensions.projectPadding * 2;
  }
  const machinesHeight = project.machines.reduce((total, machine) => (
    total + machineHeight(machine)
  ), 0);
  return topologyDimensions.projectHeaderHeight
    + machinesHeight
    + topologyDimensions.machineGap * (project.machines.length - 1)
    + topologyDimensions.projectPadding * 2;
}

function machineHeight(machine: TopologyMachine) {
  if (machine.tasks.length === 0) {
    return topologyDimensions.machineHeaderHeight
      + topologyDimensions.machinePadding * 2
      + topologyDimensions.machineStatusRowHeight;
  }
  return topologyDimensions.machineHeaderHeight
    + topologyDimensions.machinePadding * 2
    + topologyDimensions.taskHeight * machine.tasks.length
    + topologyDimensions.taskGap * (machine.tasks.length - 1);
}

function rowWidth(projectCount: number) {
  return projectCount * topologyDimensions.projectWidth
    + Math.max(0, projectCount - 1) * topologyDimensions.projectGap;
}
