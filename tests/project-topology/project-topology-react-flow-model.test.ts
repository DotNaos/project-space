import { describe, expect, test } from 'bun:test';
import { layoutProjectTopology } from '../../src/features/project-topology/project-topology-layout';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  sameTopologyViewportRequest,
  topologyNativePanViewport,
  topologyReactFlowEdges,
  topologyReactFlowNodes,
  topologyViewportRequest,
  visibleTopologyTaskIds
} from '../../src/features/project-topology/project-topology-react-flow-model';
import {
  checkedAt,
  codex,
  inventory,
  session,
  snapshot,
  worktrees
} from './project-topology-test-fixtures';

describe('project topology React Flow model', () => {
  test('converts the nested layout into fixed read-only React Flow nodes and edges', () => {
    const topology = topologyWithTasks();
    const layout = layoutProjectTopology(topology, 1280, 900);
    const nodes = topologyReactFlowNodes(layout, topology, (node) => node.kind);
    const edges = topologyReactFlowEdges(layout);
    const project = nodes.find((node) => node.data.layoutNode.kind === 'project');
    const machine = nodes.find((node) => node.data.layoutNode.kind === 'machine');
    const tasks = nodes.filter((node) => node.data.layoutNode.kind === 'task');

    expect(nodes.map((node) => node.data.layoutNode.kind)).toEqual([
      'lead',
      'project',
      'machine',
      'task',
      'task'
    ]);
    expect(project?.parentId).toBeUndefined();
    expect(machine?.parentId).toBe(project?.id);
    expect(tasks.map((task) => task.parentId)).toEqual([machine?.id, machine?.id]);
    expect(machine?.extent).toBe('parent');
    expect(tasks[0]?.extent).toBe('parent');
    expect(tasks[0]?.position).toEqual(tasks[0]?.data.layoutNode.position);
    expect(tasks[0]?.width).toBe(tasks[0]?.data.layoutNode.dimensions.width);
    expect(nodes.every((node) => (
      node.connectable === false
      && node.deletable === false
      && node.draggable === false
      && node.focusable === false
      && node.selectable === false
    ))).toBe(true);
    expect(nodes.find((node) => node.data.layoutNode.kind === 'lead')?.data.activationLabel)
      .toBe('Open Lead conversation');
    expect(project?.data.activationLabel).toBe('Focus project-space');
    expect(tasks[0]?.data.activationLabel)
      .toBe('Open #177 Introduce Lead and Project Lead coordination workflow command center');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      deletable: false,
      focusable: false,
      reconnectable: false,
      selectable: false,
      source: 'topology:lead',
      target: project?.id,
      type: 'smoothstep'
    });
  });

  test('reports only task cells that intersect the current viewport', () => {
    const topology = topologyWithTasks();
    const layout = layoutProjectTopology(topology, 1280, 900);
    const tasks = layout.nodes.filter((node) => node.kind === 'task');
    const first = tasks[0]!;
    const second = tasks[1]!;
    const viewport = {
      x: 12 - first.absolutePosition.x,
      y: 12 - first.absolutePosition.y,
      zoom: 1
    };

    expect(visibleTopologyTaskIds(layout, viewport, { height: 100, width: 100 }))
      .toEqual([first.taskId]);
    expect(visibleTopologyTaskIds(layout, {
      x: -second.absolutePosition.x - second.dimensions.width + 1,
      y: 12 - second.absolutePosition.y,
      zoom: 1
    }, { height: 100, width: 100 })).toEqual([second.taskId]);
    expect(visibleTopologyTaskIds(layout, { ...viewport, zoom: 0 }, {
      height: 100,
      width: 100
    })).toEqual([]);
  });

  test('keeps native-scale overview panning distinct from bounded focus transitions', () => {
    const topology = topologyWithTasks();
    const compactLayout = layoutProjectTopology(topology, 320, 700);
    const wideLayout = layoutProjectTopology(topology, 1280, 900);
    const compactOverview = topologyViewportRequest({
      bounds: compactLayout.bounds,
      overview: compactLayout.overviewViewport,
      target: { kind: 'overview' },
      transition: 4
    });
    const wideOverview = topologyViewportRequest({
      bounds: wideLayout.bounds,
      overview: wideLayout.overviewViewport,
      target: { kind: 'overview' },
      transition: 4
    });
    const projectFocus = topologyViewportRequest({
      bounds: { height: 400, width: 444, x: 20, y: 128 },
      overview: compactLayout.overviewViewport,
      target: { kind: 'project', projectId: 'project-a' },
      transition: 5
    });

    expect(compactLayout.overviewViewport).toEqual({ mode: 'native-pan', zoom: 0.72 });
    expect(compactOverview).toMatchObject({ kind: 'native-top', transition: 4, zoom: 0.72 });
    const nativeViewport = topologyNativePanViewport(
      compactOverview,
      { height: 700, width: 320 }
    );
    expect(nativeViewport).toMatchObject({ y: 76, zoom: 0.72 });
    expect(nativeViewport.x).toBeCloseTo(0.16);
    expect(wideOverview.kind).toBe('fit-bounds');
    expect(projectFocus).toMatchObject({
      kind: 'fit-bounds',
      target: { kind: 'project', projectId: 'project-a' },
      transition: 5
    });
  });

  test('rejects settled results from superseded transitions or different exact targets', () => {
    const request = {
      target: { kind: 'machine', machineId: 'machine-a', projectId: 'project-a' } as const,
      transition: 7
    };

    expect(sameTopologyViewportRequest(request, request)).toBe(true);
    expect(sameTopologyViewportRequest(request, { ...request, transition: 8 })).toBe(false);
    expect(sameTopologyViewportRequest(request, {
      target: { kind: 'machine', machineId: 'machine-b', projectId: 'project-a' },
      transition: 7
    })).toBe(false);
    expect(sameTopologyViewportRequest(request, {
      target: { kind: 'machine', machineId: 'machine-a', projectId: 'project-b' },
      transition: 7
    })).toBe(false);
  });
});

function topologyWithTasks() {
  const first = session(
    'machine-a',
    'thread-a',
    '/worktrees/project-space/issue-177-topology-a',
    'active'
  );
  const second = session(
    'machine-a',
    'thread-b',
    '/worktrees/project-space/issue-177-topology-b',
    'idle'
  );
  return snapshot(buildProjectTopology(inventory({
    codexByMachine: {
      'machine-a': { checkedAt, data: codex('machine-a', [first, second]), state: 'ready' }
    },
    worktreesByProject: {
      'project-a': worktrees('/projects/project-space', [{
        branchName: 'issue-177-topology-a',
        id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
        path: first.cwd!
      }, {
        branchName: 'issue-177-topology-b',
        id: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb',
        path: second.cwd!
      }])
    }
  })));
}
