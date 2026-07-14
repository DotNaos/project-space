import { describe, expect, test } from 'bun:test';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  conversation,
  inventory,
  session,
  snapshot,
  writable
} from './project-topology-test-fixtures';
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';

describe('project topology Codex identity truth', () => {
  test('deduplicates exact repeated records for one task identity', () => {
    const candidate = session(
      'machine-a',
      'thread-duplicate',
      '/projects/project-space'
    );
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [candidate, { ...candidate }]),
          state: 'ready'
        }
      }
    })));

    expect(result.projects[0]!.machines[0]!.taskInventory.state).toBe('ready');
    expect(result.projects[0]!.machines[0]!.tasks).toHaveLength(1);
  });

  test('blocks conflicting records for the same task identity', () => {
    const candidate = session(
      'machine-a',
      'thread-conflict',
      '/projects/project-space'
    );
    for (const conflict of [
      { ...candidate, title: '#999 · Conflicting task title' },
      { ...candidate, status: 'active' as const }
    ]) {
      const result = snapshot(buildProjectTopology(inventory({
        codexByMachine: {
          'machine-a': {
            checkedAt,
            data: codex('machine-a', [candidate, conflict]),
            state: 'ready'
          }
        }
      })));
      const topologyMachine = result.projects[0]!.machines[0]!;

      expect(topologyMachine.taskInventory).toEqual({
        checkedAt,
        reason: 'Codex inventory returned conflicting records for the same task identity.',
        state: 'blocked'
      });
      expect(topologyMachine.tasks).toEqual([]);
    }
  });

  test('blocks session activity newer than its Codex inventory completion evidence', () => {
    const futureSession = {
      ...session('machine-a', 'thread-future-activity', '/projects/project-space'),
      lastActivityAt: '2026-07-14T00:00:31.000Z'
    };
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [futureSession]),
          state: 'ready'
        }
      }
    })));
    const topologyMachine = result.projects[0]!.machines[0]!;

    expect(topologyMachine.taskInventory).toEqual({
      checkedAt,
      reason: 'Codex inventory returned task activity outside its evidence window.',
      state: 'blocked'
    });
    expect(topologyMachine.tasks).toEqual([]);
  });

  test('never authorizes from a transcript older than the selected task generation', () => {
    const candidate = session(
      'machine-a',
      'thread-old-transcript',
      '/projects/project-space',
      'idle'
    );
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [candidate]),
          state: 'ready'
        }
      },
      conversations: {
        [taskId]: {
          checkedAt: '2026-07-13T23:59:59.000Z',
          data: conversation(candidate),
          state: 'ready'
        }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    })));
    const task = result.projects[0]!.machines[0]!.tasks[0]!;

    expect(task.transcript).toMatchObject({
      reason: 'The Codex transcript does not cover the selected task generation.',
      state: 'blocked'
    });
    expect(task.interaction.composerVisible).toBe(false);
    expect(task.interaction.authority).toBeUndefined();
  });

  test('never authorizes when the transcript disagrees about archived state', () => {
    const candidate = session(
      'machine-a',
      'thread-archived-conflict',
      '/projects/project-space',
      'idle'
    );
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [candidate]),
          state: 'ready'
        }
      },
      conversations: {
        [taskId]: {
          checkedAt,
          data: conversation({ ...candidate, archived: true }),
          state: 'ready'
        }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    })));
    const task = result.projects[0]!.machines[0]!.tasks[0]!;

    expect(task.transcript.state).toBe('blocked');
    expect(task.interaction.composerVisible).toBe(false);
    expect(task.interaction.authority).toBeUndefined();
  });

  test('blocks stale transcript data newer than its claimed last-safe boundary', () => {
    const candidate = session(
      'machine-a',
      'thread-inconsistent-stale-transcript',
      '/projects/project-space',
      'idle'
    );
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [candidate]),
          state: 'ready'
        }
      },
      conversations: {
        [taskId]: {
          data: conversation(candidate),
          lastSafeAt: '2026-07-13T23:00:00.000Z',
          reason: 'Transcript source is offline.',
          state: 'stale'
        }
      }
    })));
    const task = result.projects[0]!.machines[0]!.tasks[0]!;

    expect(task.transcript).toMatchObject({
      reason: 'The Codex transcript does not cover the selected task generation.',
      state: 'blocked'
    });
  });
});
