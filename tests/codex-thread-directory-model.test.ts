import { describe, expect, test } from 'bun:test';
import type {
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';
import type { CodexMachine, CodexSession } from '../src/features/codex-sessions/codex-sessions-types';
import {
  codexThreadDirectory,
  countCodexThreadDirectory,
  filterCodexThreadDirectory
} from '../src/features/codex-sessions/codex-thread-directory-model';

function machine({
  id,
  name = id,
  status = 'connected'
}: {
  id: string;
  name?: string;
  status?: CodexMachine['status'];
}): CodexMachine {
  return { id, name, status };
}

function session({
  attention,
  cwd,
  lastActivityAt = '2026-08-07T10:00:00.000Z',
  machineId,
  status = 'idle',
  threadId,
  title = 'Untitled Codex task'
}: {
  attention?: CodexSession['attention'];
  cwd?: string;
  lastActivityAt?: string;
  machineId: string;
  status?: CodexSession['status'];
  threadId: string;
  title?: string;
}): CodexSession {
  return {
    ...(attention ? { attention } : {}),
    ...(cwd ? { cwd } : {}),
    lastActivityAt,
    loadedByProjectSpace: false,
    machineId,
    status,
    stored: true,
    threadId,
    title
  };
}

function project({
  id,
  machineId,
  rootPath
}: {
  id: string;
  machineId: string;
  rootPath: string;
}): ProjectSpaceRecord {
  return { id, kind: 'local', machineId, name: id, rootPath } as ProjectSpaceRecord;
}

const projects = [
  project({ id: 'project-space', machineId: 'os-macbook', rootPath: '/Users/oli/projects/project-space' })
];

describe('codexThreadDirectory', () => {
  test('keeps every thread on every machine, including ones no project owns', () => {
    const directory = codexThreadDirectory({
      machines: [machine({ id: 'os-macbook' }), machine({ id: 'os-pc', status: 'offline' })],
      projects,
      sessions: [
        session({ cwd: '/Users/oli/projects/project-space', machineId: 'os-macbook', threadId: 'a' }),
        session({ cwd: '/tmp/scratch', machineId: 'os-macbook', threadId: 'b' }),
        session({ cwd: '/srv/other', machineId: 'os-pc', threadId: 'c' })
      ]
    });

    expect(countCodexThreadDirectory(directory)).toBe(3);
    expect(directory.map((entry) => entry.id)).toEqual(['os-macbook', 'os-pc']);
  });

  test('resolves the owning project and leaves unowned threads without one', () => {
    const [macbook] = codexThreadDirectory({
      machines: [machine({ id: 'os-macbook' })],
      projects,
      sessions: [
        session({ cwd: '/Users/oli/projects/project-space/src', machineId: 'os-macbook', threadId: 'a' }),
        session({ cwd: '/tmp/scratch', machineId: 'os-macbook', threadId: 'b' })
      ]
    });

    const byThread = new Map(macbook.entries.map((entry) => [entry.threadId, entry]));
    expect(byThread.get('a')?.projectId).toBe('project-space');
    expect(byThread.get('b')?.projectId).toBeUndefined();
  });

  test('resolves a managed worktree back to its project', () => {
    const [macbook] = codexThreadDirectory({
      machines: [machine({ id: 'os-macbook' })],
      projects,
      sessions: [
        session({
          cwd: '/Users/oli/projects/.worktrees/project-space/issue-477',
          machineId: 'os-macbook',
          threadId: 'a'
        })
      ]
    });

    expect(macbook.entries[0].projectId).toBe('project-space');
  });

  test('does not match a directory on another machine', () => {
    const [pc] = codexThreadDirectory({
      machines: [machine({ id: 'os-pc' })],
      projects,
      sessions: [
        session({ cwd: '/Users/oli/projects/project-space', machineId: 'os-pc', threadId: 'a' })
      ]
    });

    expect(pc.entries[0].projectId).toBeUndefined();
  });

  test('groups connectors of one physical machine together', () => {
    const physicalMachines: PhysicalMachineRecord[] = [
      { connectorIds: ['connector-a', 'connector-b'], id: 'os-macbook', name: 'os-macbook' }
    ];
    const directory = codexThreadDirectory({
      machines: [machine({ id: 'connector-a' }), machine({ id: 'connector-b' })],
      physicalMachines,
      projects,
      sessions: [
        session({ machineId: 'connector-a', threadId: 'a' }),
        session({ machineId: 'connector-b', threadId: 'b' })
      ]
    });

    expect(directory).toHaveLength(1);
    expect(directory[0].name).toBe('os-macbook');
    expect(directory[0].entries).toHaveLength(2);
  });

  test('never groups a connector by the first of conflicting physical records', () => {
    const physicalMachines: PhysicalMachineRecord[] = [
      { connectorIds: ['connector-a'], id: 'physical-first', name: 'First' },
      { connectorIds: ['connector-a'], id: 'physical-second', name: 'Second' }
    ];
    const input = {
      machines: [machine({ id: 'connector-a', name: 'Exact connector' })],
      projects,
      sessions: [session({ machineId: 'connector-a', threadId: 'a' })]
    };
    const forward = codexThreadDirectory({ ...input, physicalMachines });
    const reversed = codexThreadDirectory({
      ...input,
      physicalMachines: [...physicalMachines].reverse()
    });

    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject([{ id: 'connector-a', name: 'Exact connector' }]);
  });

  test('marks attention states as active work', () => {
    const [macbook] = codexThreadDirectory({
      machines: [machine({ id: 'os-macbook' })],
      projects,
      sessions: [
        session({ attention: 'approval', machineId: 'os-macbook', threadId: 'a' }),
        session({ machineId: 'os-macbook', status: 'idle', threadId: 'b' })
      ]
    });

    const byThread = new Map(macbook.entries.map((entry) => [entry.threadId, entry]));
    expect(byThread.get('a')?.status).toBe('waiting-approval');
    expect(byThread.get('a')?.active).toBe(true);
    expect(byThread.get('b')?.active).toBe(false);
  });

  test('sorts machines by reachability and threads by last activity', () => {
    const directory = codexThreadDirectory({
      machines: [machine({ id: 'os-pc', status: 'offline' }), machine({ id: 'os-macbook' })],
      projects,
      sessions: [
        session({ lastActivityAt: '2026-08-07T09:00:00.000Z', machineId: 'os-macbook', threadId: 'old', title: 'Old' }),
        session({ lastActivityAt: '2026-08-07T11:00:00.000Z', machineId: 'os-macbook', threadId: 'new', title: 'New' }),
        session({ machineId: 'os-pc', threadId: 'c' })
      ]
    });

    expect(directory.map((entry) => entry.id)).toEqual(['os-macbook', 'os-pc']);
    expect(directory[0].entries.map((entry) => entry.threadId)).toEqual(['new', 'old']);
  });

  test('drops the issue number from the title and keeps it addressable', () => {
    const [macbook] = codexThreadDirectory({
      machines: [machine({ id: 'os-macbook' })],
      projects,
      sessions: [session({ machineId: 'os-macbook', threadId: 'a', title: '#477 · Redesign the Machines page' })]
    });

    expect(macbook.entries[0].issueNumber).toBe(477);
    expect(macbook.entries[0].title).toBe('Redesign the Machines page');
  });

  test('hides an unreachable machine that has no threads', () => {
    const directory = codexThreadDirectory({
      machines: [machine({ id: 'os-gone', status: 'unavailable' }), machine({ id: 'os-macbook' })],
      projects,
      sessions: [session({ machineId: 'os-macbook', threadId: 'a' })]
    });

    expect(directory.map((entry) => entry.id)).toEqual(['os-macbook']);
  });
});

describe('filterCodexThreadDirectory', () => {
  const directory = codexThreadDirectory({
    machines: [machine({ id: 'os-macbook' }), machine({ id: 'os-pc', name: 'thinkpad' })],
    projects,
    sessions: [
      session({
        cwd: '/Users/oli/projects/project-space',
        machineId: 'os-macbook',
        status: 'active',
        threadId: 'a',
        title: 'Redesign the Machines page'
      }),
      session({ machineId: 'os-macbook', threadId: 'b', title: 'Release tag queue' }),
      session({ machineId: 'os-pc', threadId: 'c', title: 'Windows installer' })
    ]
  });

  test('returns everything without a query', () => {
    expect(countCodexThreadDirectory(filterCodexThreadDirectory(directory, ''))).toBe(3);
  });

  test('searches titles, machines, and working directories', () => {
    expect(
      filterCodexThreadDirectory(directory, 'machines').flatMap((entry) => entry.entries.map((row) => row.threadId))
    ).toEqual(['a']);
    expect(
      filterCodexThreadDirectory(directory, 'windows').flatMap((entry) => entry.entries.map((row) => row.threadId))
    ).toEqual(['c']);
    expect(
      filterCodexThreadDirectory(directory, 'thinkpad').flatMap((entry) => entry.entries.map((row) => row.threadId))
    ).toEqual(['c']);
  });

  test('drops machines that have no matching thread left', () => {
    expect(filterCodexThreadDirectory(directory, 'windows').map((entry) => entry.id)).toEqual(['os-pc']);
  });

  test('restricts to threads that are doing work', () => {
    expect(
      filterCodexThreadDirectory(directory, '', { activeOnly: true })
        .flatMap((entry) => entry.entries.map((row) => row.threadId))
    ).toEqual(['a']);
  });
});
