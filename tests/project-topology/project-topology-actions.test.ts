import { describe, expect, test } from 'bun:test';
import {
  TopologyExistingTaskActions,
  TopologyTaskActionError,
  topologyIssueNavigationProjectId,
  topologyProjectLeadTarget
} from '../../src/features/project-topology/project-topology-actions';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  conversation,
  inventory,
  machine,
  project,
  session,
  snapshot,
  writable
} from './project-topology-test-fixtures';
import { topologyTaskId, type TopologyTask } from '../../src/features/project-topology/project-topology-types';

const actionTime = () => new Date('2026-07-14T00:01:00.000Z');

describe('project topology existing-task actions', () => {
  test('selects and continues only the same machine and thread identity', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: {
        [taskId]: writable(candidate)
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    const calls: unknown[] = [];
    const actions = new TopologyExistingTaskActions({
      async continue(origin, message) {
        calls.push({ message, origin });
        return 'continued';
      },
      async interrupt(origin, turnId) {
        calls.push({ origin, turnId });
        return 'interrupted';
      },
      async select(origin) {
        calls.push({ origin });
      }
    }, actionTime);

    await actions.select(task);
    expect(await actions.continue(task, '  Keep going  ')).toBe('continued');
    expect(calls).toEqual([
      { origin: { machineId: 'machine-a', threadId: 'thread-a' } },
      {
        message: 'Keep going',
        origin: { machineId: 'machine-a', threadId: 'thread-a' }
      }
    ]);
    expect(Object.keys((calls[1] as { origin: object }).origin).sort()).toEqual([
      'machineId', 'threadId'
    ]);
  });

  test('does not call continue when the exact task is not proven writable', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let called = false;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        called = true;
        return undefined;
      },
      async interrupt() {
        called = true;
        return undefined;
      },
      async select() {}
    }, actionTime);

    expect(() => actions.continue(task, 'Try anyway')).toThrow(TopologyTaskActionError);
    expect(() => actions.interrupt(task)).toThrow(TopologyTaskActionError);
    expect(called).toBe(false);
  });

  test('rejects whitespace-only follow-ups without dispatching', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let called = false;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        called = true;
      },
      async interrupt() {
        called = true;
      },
      async select() {}
    }, actionTime);

    expect(() => actions.continue(task, ' \n\t ')).toThrow(TopologyTaskActionError);
    expect(called).toBe(false);
  });

  test('derives an interrupt target from current exact-task authority', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'active');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: {
        [taskId]: writable(candidate, {
          canContinue: false,
          interruptTurnId: 'turn-a'
        })
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    const calls: unknown[] = [];
    const actions = new TopologyExistingTaskActions({
      async continue() {
        throw new Error('Continue was not expected.');
      },
      async interrupt(origin, turnId) {
        calls.push({ origin, turnId });
        return 'interrupted';
      },
      async select() {}
    }, actionTime);

    expect(await actions.interrupt(task)).toBe('interrupted');
    expect(calls).toEqual([{
      origin: { machineId: 'machine-a', threadId: 'thread-a' },
      turnId: 'turn-a'
    }]);
  });

  test('rejects a malformed interrupt turn before dispatch', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'active');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: {
        [taskId]: writable(candidate, {
          canContinue: false,
          interruptTurnId: 'turn with spaces'
        })
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let called = false;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        called = true;
      },
      async interrupt() {
        called = true;
      },
      async select() {}
    }, actionTime);

    expect(task.interaction.composerVisible).toBe(false);
    expect(task.interaction.canInterrupt).toBe(false);
    expect(() => actions.interrupt(task)).toThrow(TopologyTaskActionError);
    expect(called).toBe(false);
  });

  test('rejects expired authority at action time', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: {
        [taskId]: writable(candidate, { expiresAt: '2026-07-14T00:02:00.000Z' })
      }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let called = false;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        called = true;
      },
      async interrupt() {
        called = true;
      },
      async select() {
        called = true;
      }
    }, () => new Date('2026-07-14T00:02:00.000Z'));

    expect(() => actions.continue(task, 'Keep going')).toThrow(TopologyTaskActionError);
    expect(called).toBe(false);
  });

  test('rejects future, stale, and overlong authority at action time', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let called = false;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        called = true;
      },
      async interrupt() {
        called = true;
      },
      async select() {}
    }, actionTime);
    const futureAuthority = {
      ...task,
      interaction: {
        ...task.interaction,
        authority: {
          ...task.interaction.authority!,
          checkedAt: '2026-07-14T00:02:00.000Z'
        }
      }
    } as TopologyTask;
    const staleAuthority = {
      ...task,
      interaction: {
        ...task.interaction,
        authority: {
          ...task.interaction.authority!,
          sessionLastActivityAt: '2026-07-13T23:59:00.000Z'
        }
      }
    } as TopologyTask;
    const overlongAuthority = {
      ...task,
      interaction: {
        ...task.interaction,
        authority: {
          ...task.interaction.authority!,
          expiresAt: '2026-07-14T00:10:00.000Z'
        }
      }
    } as TopologyTask;

    for (const invalid of [futureAuthority, staleAuthority, overlongAuthority]) {
      expect(() => actions.continue(invalid, 'Try anyway')).toThrow(TopologyTaskActionError);
    }
    expect(called).toBe(false);
  });

  test('rejects follow-up authority from a different task-evidence revision', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    const changedEvidence = {
      ...task,
      evidence: {
        ...task.evidence,
        sessionRevision: 'b'.repeat(64)
      }
    } as TopologyTask;
    let called = false;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        called = true;
      },
      async interrupt() {
        called = true;
      },
      async select() {}
    }, actionTime);

    expect(() => actions.continue(changedEvidence, 'Try anyway'))
      .toThrow(TopologyTaskActionError);
    expect(called).toBe(false);
  });

  test('propagates controller rejection after exactly one dispatch', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let calls = 0;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        calls += 1;
        throw new Error('Runtime rejected the follow-up.');
      },
      async interrupt() {
        throw new Error('Interrupt was not expected.');
      },
      async select() {}
    }, actionTime);

    await expect(actions.continue(task, 'Keep going')).rejects.toThrow(
      'Runtime rejected the follow-up.'
    );
    expect(calls).toBe(1);
  });

  test('allows only one in-flight write per existing task', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let release!: () => void;
    let calls = 0;
    const firstResult = new Promise<string>((resolve) => {
      release = () => resolve('continued');
    });
    const actions = new TopologyExistingTaskActions({
      async continue() {
        calls += 1;
        return calls === 1 ? firstResult : 'continued-again';
      },
      async interrupt() {
        throw new Error('Interrupt was not expected.');
      },
      async select() {}
    }, actionTime);

    const first = actions.continue(task, 'First');
    expect(() => actions.continue(task, 'Second')).toThrow(TopologyTaskActionError);
    expect(calls).toBe(1);
    release();
    expect(await first).toBe('continued');
    expect(await actions.continue(task, 'Third')).toBe('continued-again');
    expect(calls).toBe(2);
  });

  test('rejects mixed task, session, and authority identities before dispatch', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const task = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    }))).projects[0]!.machines[0]!.tasks[0]!;
    let called = false;
    const actions = new TopologyExistingTaskActions({
      async continue() {
        called = true;
      },
      async interrupt() {
        called = true;
      },
      async select() {
        called = true;
      }
    }, actionTime);
    const mixedTask = { ...task, machineId: 'machine-b' } as TopologyTask;
    const mixedSession = {
      ...task,
      session: { ...task.session, id: 'thread-b' }
    } as TopologyTask;
    const mixedAuthority = {
      ...task,
      interaction: {
        ...task.interaction,
        authority: { ...task.interaction.authority!, threadId: 'thread-b' }
      }
    } as TopologyTask;

    for (const invalid of [mixedTask, mixedSession]) {
      expect(() => actions.select(invalid)).toThrow(TopologyTaskActionError);
      expect(() => actions.continue(invalid, 'Try anyway')).toThrow(TopologyTaskActionError);
    }
    expect(() => actions.continue(mixedAuthority, 'Try anyway')).toThrow(TopologyTaskActionError);
    expect(called).toBe(false);
  });

  test('builds the real Project Chat target for the project lead', () => {
    const topology = snapshot(buildProjectTopology(inventory()));
    expect(topology.lead.conversationTarget).toBe('portfolio');
    expect(topologyProjectLeadTarget(topology.projects[0]!)).toEqual({
      chatProjectId: 'github:177',
      kind: 'project-lead',
      projectId: 'github:dotnaos/project-space'
    });
  });

  test('opens issues only through a concrete single, focused, or primary machine record', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space'),
      project('project-b', 'machine-b', '/b/project-space')
    ];
    const machines = [machine('machine-a'), machine('machine-b')];
    const ambiguous = snapshot(buildProjectTopology(inventory({ machines, projects })))
      .projects[0]!;
    const primary = snapshot(buildProjectTopology(inventory({
      machines,
      primaryMachineByProject: {
        'github:dotnaos/project-space': {
          machineId: 'machine-b',
          source: 'project-configuration'
        }
      },
      projects
    }))).projects[0]!;
    const single = snapshot(buildProjectTopology(inventory())).projects[0]!;

    expect(topologyIssueNavigationProjectId(single)).toBe('project-a');
    expect(topologyIssueNavigationProjectId(ambiguous)).toBeUndefined();
    expect(topologyIssueNavigationProjectId(ambiguous, ambiguous.machines[0])).toBe('project-a');
    expect(topologyIssueNavigationProjectId(primary)).toBe('project-b');
  });
});
