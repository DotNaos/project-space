import { describe, expect, test } from 'bun:test';
import type { GitHubRepositoryDetailsResult } from '@/shared/project-space-api';
import type { CodexSessionReadResult } from '@/shared/codex-sessions-api';
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
  repositoryDetails,
  session,
  snapshot,
  worktrees
} from './project-topology-test-fixtures';
import {
  topologyTaskId,
  type ProjectTopologyInventory,
  type TopologyBrowserCapability
} from '../../src/features/project-topology/project-topology-types';

describe('project topology trust boundaries', () => {
  test('keeps task identity scoped to the owning machine and deduplicates exact identities', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space'),
      project('project-b', 'machine-b', '/b/project-space')
    ];
    const machineA = session('machine-a', 'same-thread', '/a/project-space', 'active');
    const machineB = session('machine-b', 'same-thread', '/b/project-space', 'active');
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [machineA, machineA]), state: 'ready' },
        'machine-b': { checkedAt, data: codex('machine-b', [machineB]), state: 'ready' }
      },
      machines: [machine('machine-a'), machine('machine-b')],
      projects
    })));

    expect(result.summary.tasks.observedCount).toBe(2);
    expect(result.projects[0]!.machines.map((entry) => entry.tasks.length)).toEqual([1, 1]);
    expect(new Set(result.projects[0]!.machines.flatMap((entry) => (
      entry.tasks.map((task) => task.id)
    ))).size).toBe(2);
  });

  test('reports primary and secondary occupancy only from valid explicit evidence', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space'),
      project('project-b', 'machine-b', '/b/project-space')
    ];
    const common = {
      machines: [machine('machine-a'), machine('machine-b')],
      projects
    };
    const unknown = snapshot(buildProjectTopology(inventory(common)));
    const invalid = snapshot(buildProjectTopology(inventory({
      ...common,
      primaryMachineByProject: {
        'DotNaos/project-space': {
          machineId: 'missing-machine', source: 'project-configuration'
        }
      }
    })));
    const explicit = snapshot(buildProjectTopology(inventory({
      ...common,
      primaryMachineByProject: {
        'DotNaos/project-space': {
          machineId: 'machine-a', source: 'project-configuration'
        }
      }
    })));

    expect(unknown.projects[0]!.machines.map((entry) => entry.occupancy)).toEqual([
      'unknown', 'unknown'
    ]);
    expect(invalid.projects[0]!.machines.map((entry) => entry.occupancy)).toEqual([
      'unknown', 'unknown'
    ]);
    expect(explicit.projects[0]!.machines.map((entry) => entry.occupancy)).toEqual([
      'primary', 'secondary'
    ]);
  });

  test('rejects tied project matches, sibling prefixes, and unsafe cwd paths', () => {
    const projects = [
      project('project-a', 'machine-a', '/projects/shared', 'DotNaos/project-space'),
      project('project-b', 'machine-a', '/projects/shared', 'DotNaos/other')
    ];
    const candidates = [
      session('machine-a', 'tied', '/projects/shared/src', 'active'),
      session('machine-a', 'sibling', '/projects/shared-copy', 'active'),
      session('machine-a', 'traversal', '/projects/shared/../secret', 'active')
    ];
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', candidates), state: 'ready' }
      },
      projects,
      repositories: {
        'DotNaos/other': { checkedAt, data: repositoryDetails(), state: 'ready' },
        'DotNaos/project-space': { checkedAt, data: repositoryDetails(), state: 'ready' }
      }
    })));

    expect(result.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
    expect(result.projects.every((entry) => (
      entry.machines[0]!.taskInventory.state === 'limited'
    ))).toBe(true);
  });

  test('blocks cross-machine inventory and untrusted transcript responses', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const foreignRead = conversation(session('machine-a', 'thread-b', '/projects/project-space'));
    const badInventory = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-b', [candidate]), state: 'ready' }
      }
    })));
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const badRead = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: { checkedAt, data: foreignRead, state: 'ready' }
      }
    })));
    const nonReadOnly = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: {
          checkedAt,
          data: {
            ...conversation(candidate),
            openedReadOnly: false
          } as unknown as CodexSessionReadResult,
          state: 'ready'
        }
      }
    })));

    expect(badInventory.projects[0]!.machines[0]!.taskInventory.state).toBe('blocked');
    expect(badInventory.summary.tasks.completeness).toBe('unknown');
    const task = badRead.projects[0]!.machines[0]!.tasks[0]!;
    expect(task.transcript.state).toBe('blocked');
    expect(task.interaction.composerVisible).toBe(false);
    expect(nonReadOnly.projects[0]!.machines[0]!.tasks[0]!.transcript.state).toBe('blocked');
  });

  test('retains last-safe tasks and transcript while a connector reconnects', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const read: CodexSessionReadResult = {
      ...conversation(candidate),
      turns: [{
        id: 'turn-a',
        items: [{ id: 'message-a', kind: 'agent-message', text: 'Still here' }],
        status: 'completed'
      }]
    };
    const ready = applyTopologyBuild(undefined, buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: { [taskId]: { checkedAt, data: read, state: 'ready' } }
    })));
    const inventoryBlocked = applyTopologyBuild(ready, buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { reason: 'Connector timed out.', state: 'blocked' }
      }
    })));
    expect(inventoryBlocked.state).toBe('ready');
    if (inventoryBlocked.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    const staleTask = inventoryBlocked.snapshot.projects[0]!.machines[0]!.tasks[0]!;
    expect(staleTask.activity).toBe('stale');
    expect(staleTask.interaction.composerVisible).toBe(false);
    expect(inventoryBlocked.snapshot.summary.tasks).toEqual({
      completeness: 'partial', observedCount: 1
    });

    const transcriptChecking = applyTopologyBuild(ready, buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: { [taskId]: { state: 'checking' } }
    })));
    if (transcriptChecking.state !== 'ready') throw new Error('Expected a reconciled snapshot.');
    const transcript = transcriptChecking.snapshot.projects[0]!.machines[0]!.tasks[0]!.transcript;
    expect(transcript.state).toBe('stale');
    if (transcript.state === 'stale') expect(transcript.data[0]!.id).toBe('message-a');
  });

  test('keeps browser feeds unavailable until an authorized transport exists', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const capability = (frameUrl: string, overrides: Partial<TopologyBrowserCapability> = {}) => ({
      checkedAt,
      frameUrl,
      interaction: 'read-only' as const,
      machineId: 'machine-a',
      sessionId: 'browser-a',
      state: 'ready' as const,
      threadId: 'thread-a',
      tools: {
        console: {
          checkedAt,
          streamUrl: '/api/browser-sessions/browser-a/console'
        }
      },
      ...overrides
    });
    const browserState = (browser: TopologyBrowserCapability) => snapshot(buildProjectTopology(inventory({
      browsers: { [taskId]: browser },
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    }))).projects[0]!.machines[0]!.tasks[0]!.browser.state;

    expect(browserState(capability('/api/browser-sessions/browser-a/frame'))).toBe('unavailable');
    for (const frame of [
      '//example.test/frame',
      '/api/browser-sessions/browser-a/frame?command=whoami',
      '/api/browser-sessions/browser-a/frame#logs',
      '/api/browser-sessions/other/frame',
      '/api/browser-sessions/%2e%2e/frame'
    ]) expect(browserState(capability(frame))).toBe('unavailable');
    expect(browserState(capability('/api/browser-sessions/browser-a/frame', {
      machineId: 'machine-b'
    }))).toBe('unavailable');
    expect(browserState(capability('/api/browser-sessions/browser-a/frame', {
      tools: {
        console: { checkedAt, streamUrl: 'https://host.invalid/console' }
      }
    }))).toBe('unavailable');
  });

  test('does not mark sibling issue branches merged or deployed', () => {
    const candidate = session(
      'machine-a',
      'thread-b',
      '/worktrees/project-space/branch-b',
      'idle'
    );
    const details: GitHubRepositoryDetailsResult = {
      ...repositoryDetails('branch-a'),
      branches: [
        { isDefault: false, linkedIssueNumbers: [177], name: 'branch-a' },
        { isDefault: false, linkedIssueNumbers: [177], name: 'branch-b' }
      ],
      pullRequests: [{
        headBranch: 'branch-a',
        linkedIssueNumbers: [177],
        mergeCommitHash: 'b'.repeat(40),
        number: 200,
        state: 'merged',
        title: 'Branch A',
        url: 'https://github.com/DotNaos/project-space/pull/200'
      }]
    };
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      deployments: {
        'DotNaos/project-space': {
          checkedAt,
          data: {
            checkedAt,
            environments: [{
              deployedSha: 'b'.repeat(40),
              displayName: 'Production',
              id: 'prod',
              liveUrlState: 'available',
              verification: 'healthy'
            }],
            repositoryFullName: 'DotNaos/project-space',
            status: 'available'
          },
          state: 'ready'
        }
      },
      repositories: {
        'DotNaos/project-space': { checkedAt, data: details, state: 'ready' }
      },
      worktreesByProject: {
        'project-a': worktrees('/projects/project-space', [{
          branchName: 'branch-b',
          headSha: 'c'.repeat(40),
          id: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb',
          path: '/worktrees/project-space/branch-b'
        }])
      }
    })));

    expect(result.projects[0]!.machines[0]!.tasks[0]!.delivery).toBe('unknown');
  });

  test('does not let partial worktree inventory look ready', () => {
    const first = project('project-a', 'machine-a', '/projects/project-space');
    const second = project('project-b', 'machine-a', '/mirror/project-space');
    const scoped: ProjectTopologyInventory['worktreesByProjectScope'] = {
      [topologyProjectScope(first)]: worktrees(first.rootPath, [{
        branchName: 'main', id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa', path: first.rootPath
      }]),
      [topologyProjectScope(second)]: {
        checkedAt,
        message: 'Remote registry timed out.',
        reason: 'request-failed',
        state: 'blocked'
      }
    };
    const result = snapshot(buildProjectTopology(inventory({
      projects: [first, second],
      worktreesByScope: scoped
    })));

    expect(result.projects[0]!.machines[0]!.worktreeInventory.state).toBe('blocked');
  });

  test('does not map tasks through unusable worktree records', () => {
    for (const status of ['missing', 'broken', 'prunable', 'unavailable'] as const) {
      const discovered = worktrees('/projects/project-space', [{
        branchName: 'issue-177',
        id: `wt_${status.padEnd(24, 'a')}`,
        path: `/worktrees/project-space/${status}`
      }]);
      if (discovered.state !== 'ready') throw new Error('Expected a worktree fixture.');
      discovered.worktrees[0] = {
        ...discovered.worktrees[0],
        prunable: status === 'prunable',
        status
      };
      const candidate = session(
        'machine-a',
        `thread-${status}`,
        `/worktrees/project-space/${status}`,
        'active'
      );
      const result = snapshot(buildProjectTopology(inventory({
        codexByMachine: {
          'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
        },
        worktreesByProject: { 'project-a': discovered }
      })));

      expect(result.projects[0]!.machines[0]!.tasks).toHaveLength(0);
      expect(result.projects[0]!.machines[0]!.taskInventory.state).toBe('limited');
    }
  });

  test('preserves stale project and machine source evidence', () => {
    const projectRecord = project('project-a', 'machine-a', '/projects/project-space');
    const machineRecord = machine('machine-a');
    const projectsStale = snapshot(buildProjectTopology(inventory({
      projectsInventory: {
        data: [projectRecord],
        lastSafeAt: '2026-07-13T23:58:00.000Z',
        reason: 'Project inventory timed out.',
        state: 'stale'
      }
    })));
    const machinesStale = snapshot(buildProjectTopology(inventory({
      machinesInventory: {
        data: [machineRecord],
        lastSafeAt: '2026-07-13T23:59:00.000Z',
        reason: 'Machine inventory timed out.',
        state: 'stale'
      }
    })));

    expect(projectsStale.inventory.projects.state).toBe('stale');
    expect(projectsStale.projects[0]!.inventory.state).toBe('stale');
    expect(machinesStale.inventory.machines.state).toBe('stale');
    expect(machinesStale.projects[0]!.machines[0]!.inventory.state).toBe('stale');
  });

  test('requires explicit usable base branch and SHA for synchronization', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space'),
      project('project-b', 'machine-b', '/b/project-space')
    ];
    const result = snapshot(buildProjectTopology(inventory({
      machines: [machine('machine-a'), machine('machine-b')],
      projects,
      worktreesByProject: {
        'project-a': worktrees('/a/project-space', [{
          branchName: 'feature-a', headSha: 'a'.repeat(40), id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
          path: '/a/project-space/feature-a'
        }]),
        'project-b': worktrees('/b/project-space', [{
          branchName: 'feature-b', headSha: 'a'.repeat(40), id: 'wt_bbbbbbbbbbbbbbbbbbbbbbbb',
          path: '/b/project-space/feature-b'
        }])
      }
    })));

    expect(result.projects[0]!.multiMachineState).toBe('ambiguous');
  });

  test('does not call matching checkouts synchronized without ready machine evidence', () => {
    const projects = [
      project('project-a', 'machine-a', '/a/project-space'),
      project('project-b', 'machine-b', '/b/project-space')
    ];
    const result = snapshot(buildProjectTopology(inventory({
      machines: [machine('machine-a')],
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

    expect(result.projects[0]!.machines.find((entry) => (
      entry.id === 'machine-b'
    ))!.inventory.state).toBe('limited');
    expect(result.projects[0]!.multiMachineState).toBe('ambiguous');
  });

  test('does not trust cross-repository deployment or a reused merged branch', () => {
    const candidate = session(
      'machine-a', 'thread-a', '/worktrees/project-space/issue-177', 'idle'
    );
    const details: GitHubRepositoryDetailsResult = {
      ...repositoryDetails('issue-177'),
      pullRequests: [{
        headBranch: 'issue-177',
        linkedIssueNumbers: [177],
        mergeCommitHash: 'b'.repeat(40),
        number: 198,
        state: 'merged',
        title: 'Old branch use',
        url: 'https://github.com/DotNaos/project-space/pull/198'
      }]
    };
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      deployments: {
        'DotNaos/project-space': {
          checkedAt,
          data: {
            checkedAt,
            environments: [{
              deployedSha: 'c'.repeat(40),
              displayName: 'Production',
              id: 'prod',
              liveUrlState: 'available',
              verification: 'healthy'
            }],
            repositoryFullName: 'DotNaos/other-project',
            status: 'available'
          },
          state: 'ready'
        }
      },
      repositories: {
        'DotNaos/project-space': { checkedAt, data: details, state: 'ready' }
      },
      worktreesByProject: {
        'project-a': worktrees('/projects/project-space', [{
          branchName: 'issue-177',
          headSha: 'c'.repeat(40),
          id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
          path: '/worktrees/project-space/issue-177'
        }])
      }
    })));

    expect(result.projects[0]!.machines[0]!.tasks[0]!.delivery).toBe('unknown');
  });
});
