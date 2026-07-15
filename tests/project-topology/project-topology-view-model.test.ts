import { describe, expect, test } from 'bun:test';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  conversation,
  inventory,
  machine,
  session,
  snapshot,
  writable
} from './project-topology-test-fixtures';
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';
import {
  topologyMachineTaskArea,
  topologyTaskPreview,
  topologyTaskStatuses,
  topologyTaskWorkspace,
  topologyTruthStatus
} from '../../src/features/project-topology/project-topology-view-model';

describe('project topology honest presentation model', () => {
  test('claims an empty machine only after successful task inventory', () => {
    const ready = snapshot(buildProjectTopology(inventory()));
    const blocked = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { reason: 'The connector is unavailable.', state: 'blocked' }
      }
    })));
    const checking = snapshot(buildProjectTopology(inventory({
      codexByMachine: { 'machine-a': { state: 'checking' } }
    })));
    const contradictoryOffline = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [], true), state: 'ready' }
      },
      machines: [machine('machine-a', 'offline')]
    })));

    expect(topologyMachineTaskArea(ready.projects[0]!.machines[0]!)).toEqual({
      kind: 'proven-empty', message: 'No active tasks'
    });
    expect(topologyMachineTaskArea(blocked.projects[0]!.machines[0]!)).toMatchObject({
      kind: 'unavailable', label: 'Blocked'
    });
    expect(topologyMachineTaskArea(checking.projects[0]!.machines[0]!)).toEqual({
      detail: undefined, kind: 'unavailable', label: 'Checking'
    });
    expect(topologyMachineTaskArea(
      contradictoryOffline.projects[0]!.machines[0]!
    )).toMatchObject({ kind: 'unavailable', label: 'Stale snapshot' });
  });

  test('labels idle as unverified rather than complete', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;

    expect(topologyTaskStatuses(task)).toEqual({
      activity: { label: 'Idle, not complete', tone: 'neutral' },
      delivery: undefined
    });
  });

  test('hides browser, developer tools, and composer without proven capabilities', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    const preview = topologyTaskPreview(task);
    const workspace = topologyTaskWorkspace(task, { actionsAvailable: true, viewportWidth: 1400 });

    expect(preview).toMatchObject({ browserFrameUrl: undefined, browserReadOnly: true });
    expect(workspace).toMatchObject({
      browser: undefined,
      composer: { visible: false },
      mode: 'transcript-only',
      tools: []
    });
  });

  test('does not expose declared browser metadata without a supported transport', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      browsers: {
        [taskId]: {
          checkedAt,
          frameUrl: '/api/browser-sessions/browser-a/frame',
          interaction: 'read-only',
          machineId: 'machine-a',
          sessionId: 'browser-a',
          state: 'ready',
          threadId: 'thread-a',
          tools: {
            console: {
              checkedAt,
              streamUrl: '/api/browser-sessions/browser-a/console'
            }
          }
        }
      },
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: { [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' } }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    const narrow = topologyTaskWorkspace(task, { actionsAvailable: true, viewportWidth: 800 });
    const desktop = topologyTaskWorkspace(task, { actionsAvailable: true, viewportWidth: 1400 });

    expect(narrow.mode).toBe('transcript-only');
    expect(desktop.mode).toBe('transcript-only');
    expect(desktop.tools).toEqual([]);
    expect(desktop.browser).toBeUndefined();
    expect(desktop.composer.visible).toBe(false);
    expect(topologyTaskWorkspace(task, {
      actionsAvailable: false, viewportWidth: 1400
    }).composer.visible).toBe(false);
  });

  test('preserves blocked reasons and stale last-safe timestamps', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'missing');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;

    expect(topologyTaskStatuses(task).activity).toMatchObject({
      detail: 'The task transcript is not current for this exact Codex session.',
      label: 'Blocked'
    });
    expect(topologyTruthStatus({
      lastSafeAt: '2026-07-13T23:55:00.000Z',
      reason: 'Connector timed out.',
      state: 'stale'
    })).toEqual({
      detail: 'Connector timed out.',
      label: 'Stale snapshot',
      lastSafeAt: '2026-07-13T23:55:00.000Z',
      tone: 'warning'
    });
  });

  test('models honest send and stop composer controls for exact write authority', () => {
    const idle = session('machine-a', 'thread-idle', '/projects/project-space', 'idle');
    const active = session('machine-a', 'thread-active', '/projects/project-space', 'active');
    const idleId = topologyTaskId('machine-a', 'thread-idle');
    const activeId = topologyTaskId('machine-a', 'thread-active');
    const topology = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [idle, active]), state: 'ready' }
      },
      conversations: {
        [idleId]: { checkedAt, data: conversation(idle), state: 'ready' },
        [activeId]: { checkedAt, data: conversation(active), state: 'ready' }
      },
      writeCapabilities: {
        [idleId]: writable(idle),
        [activeId]: writable(active, {
          canContinue: false,
          interruptTurnId: 'turn-active'
        })
      }
    })));
    const tasks = topology.projects[0]!.machines[0]!.tasks;
    const idleComposer = topologyTaskWorkspace(
      tasks.find((task) => task.id === idleId)!,
      { actionsAvailable: true, viewportWidth: 1400 }
    ).composer;
    const activeComposer = topologyTaskWorkspace(
      tasks.find((task) => task.id === activeId)!,
      { actionsAvailable: true, viewportWidth: 1400 }
    ).composer;

    expect(idleComposer).toMatchObject({
      action: 'send',
      inputEnabled: true,
      visible: true
    });
    expect(activeComposer).toMatchObject({
      action: 'stop',
      inputEnabled: false,
      visible: true
    });
    expect(idleComposer).toMatchObject({
      context: { label: 'Current task', state: 'locked' },
      microphone: { state: 'unavailable' },
      model: { state: 'read-only' },
      security: { label: 'Project Space policy', state: 'managed' }
    });
  });
});
