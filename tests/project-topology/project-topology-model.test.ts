import { describe, expect, test } from 'bun:test';
import type { CodexSessionReadResult } from '@/shared/codex-sessions-api';
import {
  applyTopologyBuild,
  buildProjectTopology
} from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  conversation,
  inventory,
  machine,
  project,
  session,
  snapshot,
  writable,
  worktrees
} from './project-topology-test-fixtures';
import {
  topologyTaskId
} from '../../src/features/project-topology/project-topology-types';

describe('project topology evidence model', () => {
  test('does not attach a title-only task without canonical host cwd evidence', () => {
    const candidate = session('machine-a', 'thread-a', undefined, 'active');
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    })));

    expect(result.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
    expect(result.projects[0]!.machines[0]!.taskInventory).toMatchObject({
      state: 'limited'
    });
  });

  test('uses the longest authoritative worktree path and linked branch issue', () => {
    const candidate = session(
      'machine-a',
      'thread-a',
      '/projects/.worktrees/project-space/issue-177-topology/src',
      'active'
    );
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      worktreesByProject: {
        'project-a': worktrees('/projects/project-space', [{
          branchName: 'issue-177-topology',
          id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
          path: '/projects/.worktrees/project-space/issue-177-topology'
        }])
      }
    })));
    const task = result.projects[0]!.machines[0]!.tasks[0]!;

    expect(task.evidence).toEqual({
      current: true,
      match: 'worktree',
      matchedPath: '/projects/.worktrees/project-space/issue-177-topology',
      sessionRevision: 'a'.repeat(64),
      source: 'connector-canonical-cwd'
    });
    expect(task.issue?.number).toBe(177);
    expect(task.issue?.title).toBe('Introduce Lead and Project Lead coordination workflow');
    expect(task.activity).toBe('active');
  });

  test('groups one repository across machines and reports synchronized occupancy', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space'),
      project('project-b', 'machine-b', '/b/project-space')
    ];
    const result = snapshot(buildProjectTopology(inventory({
      machines: [machine('machine-a'), machine('machine-b')],
      projects,
      worktreesByProject: {
        'project-a': worktrees('/a/project-space', [{
          branchName: 'main', headSha: 'a'.repeat(40), id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
          isBase: true, path: '/a/project-space'
        }]),
        'project-b': worktrees('/b/project-space', [{
          branchName: 'main', headSha: 'a'.repeat(40), id: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb',
          isBase: true, path: '/b/project-space'
        }])
      }
    })));

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]!.machines).toHaveLength(2);
    expect(result.projects[0]!.multiMachineState).toBe('synchronized');
    expect(result.summary.machineCount).toBe(2);
  });

  test('keeps offline task evidence stale and never calls idle complete', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [{ ...candidate, status: 'offline' }], false),
          state: 'ready'
        }
      },
      machines: [machine('machine-a', 'offline')]
    })));
    const machineResult = result.projects[0]!.machines[0]!;

    expect(result.projects[0]!.inventory).toMatchObject({
      reason: 'The machine connector is offline.',
      state: 'stale'
    });
    expect(machineResult.inventory.state).toBe('stale');
    expect(machineResult.taskInventory.state).toBe('stale');
    expect(machineResult.tasks[0]!.activity).toBe('offline');
    expect(machineResult.tasks[0]!.delivery).toBe('unknown');
    expect(machineResult.tasks[0]!.interaction.composerVisible).toBe(false);
  });

  test('distinguishes blocked inventory from proven empty inventory', () => {
    const blocked = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { reason: 'Connector capability is unavailable.', state: 'blocked' }
      }
    })));
    const empty = snapshot(buildProjectTopology(inventory()));

    expect(blocked.projects[0]!.machines[0]!.taskInventory.state).toBe('blocked');
    expect(blocked.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
    expect(empty.projects[0]!.machines[0]!.taskInventory.state).toBe('ready');
    expect(empty.summary.tasks).toEqual({ completeness: 'complete', observedCount: 0 });
  });

  test('preserves ordered transcript items from the real read result', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const read: CodexSessionReadResult = {
      openedReadOnly: true,
      session: candidate,
      turns: [{
        id: 'turn-1',
        items: [
          { id: 'item-1', kind: 'user-message', text: 'Start' },
          { id: 'item-2', kind: 'command', status: 'completed', text: 'Inspect' },
          { id: 'item-3', kind: 'agent-message', text: 'Done' }
        ],
        status: 'completed'
      }]
    };
    const id = topologyTaskId('machine-a', 'thread-a');
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [id]: { checkedAt, data: read, state: 'ready' }
      }
    })));

    const transcript = result.projects[0]!.machines[0]!.tasks[0]!.transcript;
    expect(transcript.state).toBe('ready');
    if (transcript.state === 'ready') {
      expect(transcript.data.map((item) => item.id)).toEqual(['item-1', 'item-2', 'item-3']);
      expect(transcript.data.map((item) => item.order)).toEqual([0, 1, 2]);
    }
  });

  test('keeps browser panes unavailable until a real safe transport exists', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const id = topologyTaskId('machine-a', 'thread-a');
    const missing = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    })));
    const rejected = snapshot(buildProjectTopology(inventory({
      browsers: {
        [id]: {
          checkedAt,
          frameUrl: 'https://untrusted.example/frame',
          interaction: 'read-only',
          machineId: 'machine-a',
          sessionId: 'session-a',
          state: 'ready',
          threadId: 'thread-a',
          tools: {}
        }
      },
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    })));

    expect(missing.projects[0]!.machines[0]!.tasks[0]!.browser.state).toBe('unavailable');
    expect(rejected.projects[0]!.machines[0]!.tasks[0]!.browser).toEqual({
      reason: 'No safe browser-session transport is available for this task.',
      state: 'unavailable'
    });
  });

  test('gates follow-ups on the exact reachable idle task', () => {
    const idle = session('machine-a', 'thread-idle', '/projects/project-space', 'idle');
    const active = session('machine-a', 'thread-active', '/projects/project-space', 'active');
    const idleId = topologyTaskId('machine-a', 'thread-idle');
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [idle, active]), state: 'ready' }
      },
      conversations: {
        [idleId]: { checkedAt, data: conversation(idle), state: 'ready' }
      },
      writeCapabilities: {
        [idleId]: writable(idle)
      }
    })));
    const tasks = result.projects[0]!.machines[0]!.tasks;

    expect(tasks.find((task) => task.threadId === 'thread-idle')!.interaction).toMatchObject({
      canContinue: true,
      composerVisible: true
    });
    expect(tasks.find((task) => task.threadId === 'thread-active')!.interaction).toMatchObject({
      canContinue: false,
      canInterrupt: false,
      composerVisible: false
    });
  });

  test('rejects stale or conflicting write and transcript evidence', () => {
    const listed = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const build = (
      readSession: typeof listed,
      expiresAt: string
    ) => snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [listed]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(readSession), state: 'ready' }
      },
      writeCapabilities: {
        [taskId]: writable(listed, { expiresAt })
      }
    }))).projects[0]!.machines[0]!.tasks[0]!.interaction;

    expect(build({ ...listed, status: 'active' }, '2026-07-14T00:05:00.000Z')).toMatchObject({
      canContinue: false,
      composerVisible: false
    });
    expect(build(listed, '2026-07-13T23:59:59.000Z')).toMatchObject({
      canContinue: false,
      composerVisible: false
    });
  });

  test('retains the last safe snapshot when a refresh becomes blocked', () => {
    const readyBuild = buildProjectTopology(inventory());
    const readyState = applyTopologyBuild(undefined, readyBuild);
    const stale = applyTopologyBuild(readyState, {
      checkedAt: '2026-07-14T00:01:00.000Z',
      reason: 'Machine inventory timed out.',
      state: 'blocked'
    }, '2026-07-14T00:02:00.000Z');

    expect(stale.state).toBe('stale');
    if (stale.state === 'stale') {
      expect(stale.snapshot.checkedAt).toBe(checkedAt);
      expect(stale.reason).toBe('Machine inventory timed out.');
    }
  });
});
