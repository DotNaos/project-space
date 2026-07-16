import { describe, expect, test } from 'bun:test';
import {
  countActiveProjectCodexTasks,
  groupProjectCodexTasks,
  presentProjectCodexTaskStatus,
  projectCodexTaskId,
  projectCodexTasks
} from '../src/features/codex-sessions/project-codex-task-model';
import type {
  CodexMachine,
  CodexSession
} from '../src/features/codex-sessions/codex-sessions-types';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';

const projectRecords: ProjectSpaceRecord[] = [{
  id: 'project-mac',
  kind: 'standalone',
  machineId: 'machine-mac',
  name: 'project-space',
  rootPath: '/Users/oli/projects/project-space'
}, {
  id: 'project-pc',
  kind: 'standalone',
  machineId: 'machine-pc',
  name: 'A renamed project',
  rootPath: 'C:\\Users\\oli\\projects\\project-space'
}];

const machines: CodexMachine[] = [
  { id: 'machine-mac', name: 'os-macbook', status: 'connected' },
  { id: 'machine-pc', name: 'os-pc', status: 'offline' }
];

function session(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    cwd: '/Users/oli/projects/project-space',
    lastActivityAt: '2026-07-15T08:00:00.000Z',
    loadedByProjectSpace: true,
    machineId: 'machine-mac',
    projectName: 'misleading-display-name',
    status: 'idle',
    stored: true,
    threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9a',
    title: '#235 · Galren-QPDE87 · Implement project Codex tasks · project-space',
    ...overrides
  };
}

describe('project Codex task scoping', () => {
  test('matches exact machine and path boundaries without using display names', () => {
    const tasks = projectCodexTasks([
      session(),
      session({
        cwd: '/Users/oli/projects/project-space-copy',
        projectName: 'project-space',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9b'
      }),
      session({
        cwd: '/Users/oli/projects/project-space',
        machineId: 'some-other-machine',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9c'
      })
    ], projectRecords);

    expect(tasks.map((task) => task.threadId)).toEqual([
      '019f5a78-3c4c-7082-bb45-5411be7d9b9a'
    ]);
  });

  test('includes the repository root and Project-managed worktrees on Unix and Windows', () => {
    const tasks = projectCodexTasks([
      session({
        cwd: '/Users/oli/projects/.worktrees/project-space/issue-235/src',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9d'
      }),
      session({
        cwd: 'c:\\users\\oli\\projects\\.worktrees\\project-space\\issue-240',
        machineId: 'machine-pc',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9e'
      }),
      session({ status: 'archived' })
    ], projectRecords);

    expect(tasks.map((task) => [task.machineId, task.status])).toEqual([
      ['machine-mac', 'archived'],
      ['machine-mac', 'idle'],
      ['machine-pc', 'idle']
    ]);
  });

  test('uses machine and thread identifiers as identity and separates title metadata', () => {
    const tasks = projectCodexTasks([session({
      title: '#235·PR #242·Galren-QPDE87·Implement project Codex tasks'
    }), session({
      cwd: 'C:\\Users\\oli\\projects\\project-space',
      machineId: 'machine-pc',
      title: '#235 · Same thread, another machine'
    })], projectRecords);
    const task = tasks.find((candidate) => candidate.machineId === 'machine-mac');

    expect(task).toMatchObject({
      id: projectCodexTaskId('machine-mac', '019f5a78-3c4c-7082-bb45-5411be7d9b9a'),
      issueNumber: 235,
      pullRequestNumber: 242,
      title: 'Galren-QPDE87 · Implement project Codex tasks'
    });
    expect(task?.title).not.toContain('#235');
    expect(task?.title).not.toContain('PR #242');
    expect(tasks.map((candidate) => candidate.id)).toHaveLength(2);
  });

  test('deduplicates exact identities and keeps the newest observation', () => {
    const tasks = projectCodexTasks([
      session({ lastActivityAt: '2026-07-15T07:00:00.000Z', title: 'Old observation' }),
      session({ lastActivityAt: '2026-07-15T09:00:00.000Z', title: 'New observation' })
    ], projectRecords);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('New observation');
  });
});

describe('project Codex task grouping and state', () => {
  test('groups by physical machine and preserves unavailable task owners', () => {
    const unavailableRecord: ProjectSpaceRecord = {
      id: 'project-gone',
      kind: 'standalone',
      machineId: 'machine-gone',
      name: 'project-space',
      rootPath: '/srv/projects/project-space'
    };
    const tasks = projectCodexTasks([
      session(),
      session({
        cwd: 'C:\\Users\\oli\\projects\\project-space',
        machineId: 'machine-pc',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9b'
      }),
      session({
        cwd: '/srv/projects/project-space',
        machineId: 'machine-gone',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9c'
      })
    ], [...projectRecords, unavailableRecord]);

    const groups = groupProjectCodexTasks(tasks, machines);
    expect(groups.map((group) => [group.machine.id, group.machine.status])).toEqual([
      ['machine-mac', 'connected'],
      ['machine-pc', 'offline'],
      ['machine-gone', 'unavailable']
    ]);
  });

  test('keeps every project-scoped machine group when some have no tasks', () => {
    const tasks = projectCodexTasks([session()], projectRecords);
    const groups = groupProjectCodexTasks(tasks, machines, projectRecords.map((record) => record.machineId!));

    expect(groups.map((group) => [
      group.machine.id,
      group.machine.status,
      group.tasks.map((task) => task.threadId)
    ])).toEqual([
      ['machine-mac', 'connected', ['019f5a78-3c4c-7082-bb45-5411be7d9b9a']],
      ['machine-pc', 'offline', []]
    ]);
  });

  test('represents a scoped machine missing from inventory as unavailable without merging by name', () => {
    const groups = groupProjectCodexTasks([], [{
      id: 'machine-other',
      name: 'same display name',
      status: 'connected'
    }], ['machine-gone', 'machine-other']);

    expect(groups.map((group) => [group.machine.id, group.machine.status, group.tasks.length])).toEqual([
      ['machine-other', 'connected', 0],
      ['machine-gone', 'unavailable', 0]
    ]);
  });

  test('represents active work with a spinner and waiting states explicitly', () => {
    const id = projectCodexTaskId('machine-mac', '019f5a78-3c4c-7082-bb45-5411be7d9b9a');
    const [task] = projectCodexTasks([session({ status: 'active' })], projectRecords, {
      [id]: 'waiting-approval'
    });

    expect(task).toMatchObject({ active: true, status: 'waiting-approval' });
    expect(presentProjectCodexTaskStatus('active')).toEqual({
      indicator: 'spinner',
      label: 'Active',
      loading: true,
      status: 'active'
    });
    expect(presentProjectCodexTaskStatus('waiting-input').label).toBe('Waiting for input');
    expect(presentProjectCodexTaskStatus('idle', 'offline').status).toBe('offline');
    expect(presentProjectCodexTaskStatus('active').label).not.toBe('Running');
    expect(projectCodexTasks([session({ attention: 'input', status: 'active' })], projectRecords)[0])
      .toMatchObject({ status: 'waiting-input' });
  });

  test('does not count cached active sessions on offline machines as active work', () => {
    const tasks = projectCodexTasks([
      session({ status: 'active' }),
      session({
        cwd: 'C:\\Users\\oli\\projects\\project-space',
        machineId: 'machine-pc',
        status: 'active',
        threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9b'
      })
    ], projectRecords);
    const groups = groupProjectCodexTasks(tasks, machines);

    expect(countActiveProjectCodexTasks(tasks, groups)).toBe(1);
  });
});
