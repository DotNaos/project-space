import { describe, expect, test } from 'bun:test';
import type { ProjectWorktreeDiscoveryState } from '@/shared/project-space-api';
import { topologyProjectScope } from '../../src/features/project-topology/project-topology-inventory-evidence';
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
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';

const blockedWorktrees: ProjectWorktreeDiscoveryState = {
  checkedAt,
  message: 'Worktree discovery failed.',
  reason: 'request-failed',
  state: 'blocked'
};

describe('project topology worktree trust boundaries', () => {
  test('preserves stale truth around a last-safe proven-empty worktree inventory', () => {
    const projectRecord = project('project-a', 'machine-a', '/projects/project-space');
    const empty = worktrees(projectRecord.rootPath, []);
    if (empty.state !== 'proven-empty') throw new Error('Expected proven-empty evidence.');
    const result = snapshot(buildProjectTopology(inventory({
      projects: [projectRecord],
      worktreesByScope: {
        [topologyProjectScope(projectRecord)]: {
          data: empty,
          lastSafeAt: checkedAt,
          reason: 'Worktree discovery is offline.',
          state: 'stale'
        }
      }
    })));

    expect(result.projects[0]!.machines[0]!.worktreeInventory).toMatchObject({
      lastSafeAt: checkedAt,
      state: 'stale'
    });
  });

  test('keeps a stale-mapped task read-only even when Codex write evidence is current', () => {
    const projectRecord = project('project-a', 'machine-a', '/projects/project-space');
    const candidate = session(
      'machine-a',
      'thread-stale-map',
      '/external/project-space/issue-177',
      'idle'
    );
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const discovered = worktrees(projectRecord.rootPath, [{
      branchName: 'issue-177',
      id: 'wt_stalestale_stalestale_aa',
      path: candidate.cwd!
    }]);
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      projects: [projectRecord],
      worktreesByScope: {
        [topologyProjectScope(projectRecord)]: {
          data: discovered,
          lastSafeAt: checkedAt,
          reason: 'Worktree discovery is offline.',
          state: 'stale'
        }
      },
      writeCapabilities: { [taskId]: writable(candidate) }
    })));
    const topologyMachine = result.projects[0]!.machines[0]!;
    const task = topologyMachine.tasks[0]!;

    expect(topologyMachine.taskInventory.state).toBe('stale');
    expect(task.activity).toBe('stale');
    expect(task.evidence).toMatchObject({ current: false, lastSafeAt: checkedAt });
    expect(task.interaction.composerVisible).toBe(false);
    expect(task.interaction.authority).toBeUndefined();
  });

  test('rejects worktree evidence filed under another project scope', () => {
    const owner = project('project-owner', 'machine-a', '/projects/owner');
    const foreign = project('project-foreign', 'machine-a', '/projects/foreign', 'DotNaos/other');
    const candidate = session(
      'machine-a',
      'thread-foreign',
      '/external/foreign/issue-177',
      'active'
    );
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      projects: [owner, foreign],
      worktreesByScope: {
        [topologyProjectScope(owner)]: worktrees(foreign.rootPath, [{
          branchName: 'issue-177',
          id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
          path: candidate.cwd!
        }]),
        [topologyProjectScope(foreign)]: worktrees(foreign.rootPath, [])
      }
    })));

    expect(result.projects.flatMap((entry) => (
      entry.machines.flatMap((machine) => machine.tasks)
    ))).toHaveLength(0);
    const ownerMachine = result.projects.find((entry) => (
      entry.repositoryFullName === 'DotNaos/project-space'
    ))!.machines[0]!;
    expect(ownerMachine.worktreeInventory.state).toBe('blocked');
    expect(ownerMachine.taskInventory.state).toBe('blocked');
  });

  test('retains an external worktree task without interaction authority when discovery blocks', () => {
    const candidate = session(
      'machine-a',
      'thread-external',
      '/external/project-space/issue-177',
      'idle'
    );
    const taskId = topologyTaskId(candidate.machineId, candidate.id);
    const discovered = worktrees('/projects/project-space', [{
      branchName: 'issue-177',
      id: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb',
      path: candidate.cwd!
    }]);
    if (discovered.state !== 'ready') throw new Error('Expected ready worktree evidence.');
    discovered.worktrees[0] = { ...discovered.worktrees[0], kind: 'external' };
    const ready = applyTopologyBuild(undefined, buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: conversation(candidate), state: 'ready' }
      },
      worktreesByProject: { 'project-a': discovered },
      writeCapabilities: { [taskId]: writable(candidate) }
    })));
    if (ready.state !== 'ready') throw new Error('Expected a ready topology snapshot.');
    expect(ready.snapshot.projects[0]!.machines[0]!.tasks[0]!.interaction.composerVisible)
      .toBe(true);

    const refreshed = applyTopologyBuild(ready, buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      worktreesByProject: { 'project-a': blockedWorktrees }
    })));
    if (refreshed.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    const machine = refreshed.snapshot.projects[0]!.machines[0]!;
    const retained = machine.tasks[0]!;

    expect(machine.worktreeInventory.state).toBe('blocked');
    expect(machine.taskInventory.state).toBe('stale');
    expect(retained.cwd).toBe(candidate.cwd);
    expect(retained.activity).toBe('stale');
    expect(retained.interaction).toMatchObject({
      canContinue: false,
      canInterrupt: false,
      composerVisible: false
    });
    expect(retained.interaction.authority).toBeUndefined();
    expect(retained.transcript.state).toBe('stale');
  });

  test('does not fall back to a project root through a nested unusable worktree', () => {
    const candidate = session(
      'machine-a',
      'thread-nested',
      '/projects/project-space/.worktrees/issue-177/src',
      'active'
    );
    const discovered = worktrees('/projects/project-space', [{
      branchName: 'main',
      id: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb',
      isBase: true,
      path: '/projects/project-space'
    }, {
      branchName: 'issue-177',
      id: 'wt_cccccccccccccccccccccccc',
      path: '/projects/project-space/.worktrees/issue-177'
    }]);
    if (discovered.state !== 'ready') throw new Error('Expected ready worktree evidence.');
    discovered.worktrees[1] = { ...discovered.worktrees[1], status: 'broken' };
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      worktreesByProject: { 'project-a': discovered }
    })));
    const machine = result.projects[0]!.machines[0]!;

    expect(machine.tasks).toHaveLength(0);
    expect(machine.taskInventory.state).toBe('limited');
  });

  test('does not cross a more-specific project root with blocked discovery', () => {
    const parent = project(
      'project-parent',
      'machine-a',
      '/projects/mono',
      'DotNaos/mono'
    );
    const child = project(
      'project-child',
      'machine-a',
      '/projects/mono/child',
      'DotNaos/child'
    );
    const candidate = session(
      'machine-a',
      'thread-child-blocked',
      '/projects/mono/child/src',
      'active'
    );
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      projects: [parent, child],
      worktreesByScope: {
        [topologyProjectScope(parent)]: worktrees(parent.rootPath, []),
        [topologyProjectScope(child)]: blockedWorktrees
      }
    })));

    expect(result.projects.flatMap((entry) => (
      entry.machines.flatMap((entryMachine) => entryMachine.tasks)
    ))).toEqual([]);
    const childMachine = result.projects
      .find((entry) => entry.repositoryFullName === 'DotNaos/child')!
      .machines[0]!;
    const parentMachine = result.projects
      .find((entry) => entry.repositoryFullName === 'DotNaos/mono')!
      .machines[0]!;
    expect(childMachine.taskInventory.state).toBe('blocked');
    expect(parentMachine.taskInventory.state).toBe('limited');
  });

  test('blocks conflicting duplicate worktree identities', () => {
    const candidate = session(
      'machine-a',
      'thread-worktree-conflict',
      '/projects/project-space/.worktrees/issue-177/src',
      'active'
    );
    const discovered = worktrees('/projects/project-space', [{
      branchName: 'branch-a',
      id: 'wt_conflictconflictconflict',
      path: '/projects/project-space/.worktrees/issue-177'
    }, {
      branchName: 'branch-b',
      id: 'wt_conflictconflictconflict',
      path: '/projects/project-space/.worktrees/issue-177'
    }]);
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      worktreesByProject: { 'project-a': discovered }
    })));
    const topologyMachine = result.projects[0]!.machines[0]!;

    expect(topologyMachine.worktreeInventory).toMatchObject({
      message: 'Worktree evidence returned conflicting records for the same checkout identity.',
      state: 'blocked'
    });
    expect(topologyMachine.taskInventory.state).toBe('blocked');
    expect(topologyMachine.tasks).toEqual([]);
  });

  test('collapses exact duplicate worktree records without changing attribution', () => {
    const candidate = session(
      'machine-a',
      'thread-worktree-exact-duplicate',
      '/projects/project-space/.worktrees/issue-177/src',
      'active'
    );
    const discovered = worktrees('/projects/project-space', [{
      branchName: 'issue-177',
      id: 'wt_exactexactexactexactexact',
      path: '/projects/project-space/.worktrees/issue-177'
    }]);
    if (discovered.state !== 'ready') throw new Error('Expected ready worktree evidence.');
    discovered.worktrees.push({ ...discovered.worktrees[0]! });
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      worktreesByProject: { 'project-a': discovered }
    })));
    const topologyMachine = result.projects[0]!.machines[0]!;

    expect(topologyMachine.worktreeInventory.state).toBe('ready');
    expect(topologyMachine.worktrees).toHaveLength(1);
    expect(topologyMachine.tasks).toHaveLength(1);
    expect(topologyMachine.tasks[0]!.branchName).toBe('issue-177');
  });

  test('merges stale worktree times chronologically and keeps the matching reason', () => {
    const later = project('project-later', 'machine-a', '/projects/later');
    const earlier = project('project-earlier', 'machine-a', '/projects/earlier');
    const laterAt = '2026-07-13T20:00:00.000Z';
    const earlierAt = '2026-07-14T00:00:00+09:00';
    const staleEmpty = (
      record: typeof later,
      lastSafeAt: string,
      reason: string
    ) => {
      const empty = worktrees(record.rootPath, []);
      return {
        data: {
          ...empty,
          evidence: { ...empty.evidence, checkedAt: lastSafeAt }
        },
        lastSafeAt,
        reason,
        state: 'stale' as const
      };
    };
    const result = snapshot(buildProjectTopology(inventory({
      projects: [later, earlier],
      worktreesByScope: {
        [topologyProjectScope(later)]: staleEmpty(later, laterAt, 'Later cache.'),
        [topologyProjectScope(earlier)]: staleEmpty(earlier, earlierAt, 'Earlier cache.')
      }
    })));
    const merged = result.projects[0]!.machines[0]!.worktreeInventory;

    expect(merged).toMatchObject({
      lastSafeAt: earlierAt,
      reason: 'Earlier cache.',
      state: 'stale'
    });
  });

  test('treats conflicting duplicate project records at one machine and path as ambiguous', () => {
    const records = [
      project('project-a', 'machine-a', '/projects/project-space'),
      project('project-duplicate', 'machine-a', '/projects/project-space')
    ];
    const candidate = session(
      'machine-a',
      'thread-duplicate',
      '/projects/project-space/src',
      'active'
    );
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      projects: records
    })));
    const machine = result.projects[0]!.machines[0]!;

    expect(result.projects).toHaveLength(1);
    expect(machine.tasks).toHaveLength(0);
    expect(machine.taskInventory.state).toBe('limited');
    expect(result.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
  });

  test('does not hide divergent base checkouts behind the first matching checkout', () => {
    const projects = [
      project('project-a-main', 'machine-a', '/a/project-space'),
      project('project-a-feature', 'machine-a', '/a/project-space-feature'),
      project('project-b-main', 'machine-b', '/b/project-space')
    ];
    const base = (projectPath: string, branchName: string, headSha: string, id: string) => (
      worktrees(projectPath, [{ branchName, headSha, id, isBase: true, path: projectPath }])
    );
    const result = snapshot(buildProjectTopology(inventory({
      machines: [
        machine('machine-a'),
        machine('machine-b')
      ],
      projects,
      worktreesByProject: {
        'project-a-feature': base(
          '/a/project-space-feature',
          'feature',
          'b'.repeat(40),
          'wt_eeeeeeeeeeeeeeeeeeeeeeee'
        ),
        'project-a-main': base(
          '/a/project-space',
          'main',
          'a'.repeat(40),
          'wt_ffffffffffffffffffffffff'
        ),
        'project-b-main': base(
          '/b/project-space',
          'main',
          'a'.repeat(40),
          'wt_gggggggggggggggggggggggg'
        )
      }
    })));

    expect(result.projects[0]!.multiMachineState).toBe('ambiguous');
  });

  test('does not normalize adversarial POSIX whitespace or backslashes into trusted paths', () => {
    const backslashPath = '/external/project-space\\issue-177';
    const candidates = [
      session('machine-a', 'thread-space', '/projects/project-space/src ', 'active'),
      session('machine-a', 'thread-backslash', backslashPath, 'active')
    ];
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', candidates), state: 'ready' }
      },
      worktreesByProject: {
        'project-a': worktrees('/projects/project-space', [{
          branchName: 'issue-177',
          id: 'wt_dddddddddddddddddddddddd',
          path: backslashPath
        }])
      }
    })));
    const machine = result.projects[0]!.machines[0]!;

    expect(machine.tasks).toHaveLength(0);
    expect(machine.worktreeInventory.state).toBe('blocked');
    expect(machine.taskInventory.state).toBe('blocked');
    expect(result.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
  });
});
