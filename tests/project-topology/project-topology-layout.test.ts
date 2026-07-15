import { describe, expect, test } from 'bun:test';
import {
  layoutProjectTopology,
  topologyDimensions,
  topologyFocusBounds
} from '../../src/features/project-topology/project-topology-layout';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  inventory,
  machine,
  project,
  repositoryDetails,
  session,
  snapshot
} from './project-topology-test-fixtures';

describe('project topology nested layout', () => {
  test('nests only real machine and task nodes inside their containers', () => {
    const first = session('machine-a', 'thread-a', '/projects/project-space', 'active');
    const second = session('machine-a', 'thread-b', '/projects/project-space', 'idle');
    const topology = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [first, second]), state: 'ready' }
      }
    })));
    const layout = layoutProjectTopology(topology, 1200);
    const projectNode = layout.nodes.find((node) => node.kind === 'project')!;
    const machineNode = layout.nodes.find((node) => node.kind === 'machine')!;
    const taskNodes = layout.nodes.filter((node) => node.kind === 'task');

    expect(machineNode.parentId).toBe(projectNode.id);
    expect(taskNodes).toHaveLength(2);
    expect(taskNodes.every((node) => node.parentId === machineNode.id)).toBe(true);
    expect(taskNodes[0]!.dimensions).toEqual({
      height: topologyDimensions.taskHeight,
      width: topologyDimensions.taskWidth
    });
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]!.target).toBe(projectNode.id);
  });

  test('reserves a quiet truth row without inventing an empty task slot', () => {
    const topology = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { reason: 'Connector is still negotiating capabilities.', state: 'blocked' }
      }
    })));
    const layout = layoutProjectTopology(topology, 600);
    const machineNode = layout.nodes.find((node) => node.kind === 'machine')!;

    expect(layout.nodes.filter((node) => node.kind === 'task')).toHaveLength(0);
    expect(machineNode.dimensions.height).toBe(
      topologyDimensions.machineHeaderHeight
        + topologyDimensions.machinePadding * 2
        + topologyDimensions.machineStatusRowHeight
    );
  });

  test('keeps one horizontal project row and requests native-scale panning when narrow', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space', 'DotNaos/project-space'),
      project('project-b', 'machine-b', '/b/other', 'DotNaos/other')
    ];
    const topology = snapshot(buildProjectTopology(inventory({
      machines: [machine('machine-a'), machine('machine-b')],
      projects,
      repositories: {
        'DotNaos/other': { checkedAt, data: repositoryDetails(), state: 'ready' },
        'DotNaos/project-space': { checkedAt, data: repositoryDetails(), state: 'ready' }
      }
    })));
    const narrow = layoutProjectTopology(topology, 390);
    const desktop = layoutProjectTopology(topology, 1280);
    const narrowProjects = narrow.nodes.filter((node) => node.kind === 'project');
    const desktopProjects = desktop.nodes.filter((node) => node.kind === 'project');

    expect(narrow.bounds.width).toBe(
      topologyDimensions.projectWidth * 2 + topologyDimensions.projectGap
    );
    expect(narrow.overviewViewport.mode).toBe('native-pan');
    expect(narrow.overviewViewport.zoom).toBeCloseTo(374 / topologyDimensions.projectWidth);
    expect(narrow.overviewViewport.anchorX).toBe(
      topologyDimensions.projectWidth + topologyDimensions.projectGap
        + topologyDimensions.projectWidth / 2
    );
    expect(desktop.overviewViewport).toEqual({ mode: 'fit' });
    expect(narrowProjects[0]!.absolutePosition.y).toBe(narrowProjects[1]!.absolutePosition.y);
    expect(narrowProjects[0]!.absolutePosition.x).not.toBe(narrowProjects[1]!.absolutePosition.x);
    expect(desktopProjects[0]!.absolutePosition.y).toBe(desktopProjects[1]!.absolutePosition.y);
    expect(desktopProjects[0]!.absolutePosition.x).not.toBe(desktopProjects[1]!.absolutePosition.x);
  });

  test('keeps native-scale panning when tall content would make text unreadable', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'active');
    const topology = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    })));

    expect(layoutProjectTopology(topology, 1200, 300).overviewViewport).toEqual({
      anchorX: topologyDimensions.projectWidth / 2,
      mode: 'native-pan',
      zoom: 1
    });
    expect(layoutProjectTopology(topology, 1200, 1000).overviewViewport).toEqual({ mode: 'fit' });
  });

  test('fits a moderately wider desktop portfolio while preserving readable zoom', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space', 'DotNaos/project-a'),
      project('project-b', 'machine-b', '/b/project-space', 'DotNaos/project-b'),
      project('project-c', 'machine-c', '/c/project-space', 'DotNaos/project-c')
    ];
    const topology = snapshot(buildProjectTopology(inventory({
      machines: [machine('machine-a'), machine('machine-b'), machine('machine-c')],
      projects
    })));

    expect(layoutProjectTopology(topology, 1280, 900).bounds.width).toBeGreaterThan(1280);
    expect(layoutProjectTopology(topology, 1280, 900).overviewViewport).toEqual({ mode: 'fit' });
    expect(layoutProjectTopology(topology, 700, 900).overviewViewport).toMatchObject({
      mode: 'native-pan', zoom: 0.72
    });
  });

  test('keeps three readable project containers fully inside a wide panning viewport', () => {
    const projects = Array.from({ length: 12 }, (_, index) => (
      project(
        `project-${index}`,
        `machine-${index}`,
        `/projects/project-${index}`,
        `DotNaos/project-${index}`
      )
    ));
    const topology = snapshot(buildProjectTopology(inventory({
      machines: projects.map((candidate) => machine(candidate.machineId!)),
      projects
    })));
    const viewportWidth = 1368;
    const layout = layoutProjectTopology(topology, viewportWidth, 900);

    expect(layout.overviewViewport.mode).toBe('native-pan');
    if (layout.overviewViewport.mode !== 'native-pan') return;
    const threeProjectWidth = topologyDimensions.projectWidth * 3
      + topologyDimensions.projectGap * 2;
    expect(threeProjectWidth * layout.overviewViewport.zoom).toBeLessThanOrEqual(
      viewportWidth - 32
    );
    expect(layout.overviewViewport.zoom).toBeGreaterThanOrEqual(0.72);
    const lead = layout.nodes.find((node) => node.kind === 'lead')!;
    expect(lead.absolutePosition.x + lead.dimensions.width / 2).toBe(
      layout.overviewViewport.anchorX
    );
  });

  test('preserves project padding around nested machines', () => {
    const topology = snapshot(buildProjectTopology(inventory()));
    const layout = layoutProjectTopology(topology, 1200);
    const projectNode = layout.nodes.find((node) => node.kind === 'project')!;
    const machineNode = layout.nodes.find((node) => node.kind === 'machine')!;

    expect(machineNode.position.y).toBe(
      topologyDimensions.projectHeaderHeight + topologyDimensions.projectPadding
    );
    expect(projectNode.dimensions.height - (
      machineNode.position.y + machineNode.dimensions.height
    )).toBe(topologyDimensions.projectPadding);
  });

  test('returns exact absolute bounds for project, machine, task, and portfolio focus', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'active');
    const topology = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    })));
    const layout = layoutProjectTopology(topology, 1200);
    const projectNode = layout.nodes.find((node) => node.kind === 'project')!;
    const machineNode = layout.nodes.find((node) => node.kind === 'machine')!;
    const taskNode = layout.nodes.find((node) => node.kind === 'task')!;

    expect(topologyFocusBounds(layout, { kind: 'overview' })).toEqual(layout.bounds);
    expect(topologyFocusBounds(layout, {
      kind: 'project', projectId: topology.projects[0]!.id
    })).toEqual({ ...projectNode.absolutePosition, ...projectNode.dimensions });
    expect(topologyFocusBounds(layout, {
      kind: 'machine',
      machineId: topology.projects[0]!.machines[0]!.id,
      projectId: topology.projects[0]!.id
    })).toEqual({ ...machineNode.absolutePosition, ...machineNode.dimensions });
    expect(topologyFocusBounds(layout, {
      kind: 'task', taskId: topology.projects[0]!.machines[0]!.tasks[0]!.id
    })).toEqual({ ...taskNode.absolutePosition, ...taskNode.dimensions });
  });
});
