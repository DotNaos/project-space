import { describe, expect, test } from 'bun:test';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  checkedAt,
  codex,
  inventory,
  repositoryDetails,
  session,
  snapshot,
  worktrees
} from './project-topology-test-fixtures';
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';

describe('project topology evidence freshness', () => {
  test('shows awaiting decision only while exact live evidence remains fresh', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'active');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const activity = (
      expiresAt: string,
      threadId = 'thread-a',
      observedAt = checkedAt
    ) => snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      taskEvidence: {
        [taskId]: {
          awaitingDecision: {
            expiresAt,
            observedAt,
            sessionLastActivityAt: candidate.lastActivityAt
          },
          machineId: 'machine-a',
          threadId
        }
      }
    }))).projects[0]!.machines[0]!.tasks[0]!.activity;

    expect(activity('2026-07-14T00:00:30.000Z')).toBe('awaiting-decision');
    expect(activity('2026-07-13T23:59:59.000Z')).toBe('active');
    expect(activity('2026-07-14T00:00:30.000Z', 'thread-b')).toBe('active');
    expect(activity(
      '2026-07-14T00:02:00.000Z',
      'thread-a',
      '2026-07-14T00:01:00.000Z'
    )).toBe('active');
    expect(activity('2026-07-14T01:00:00.000Z')).toBe('active');
  });

  test('invalidates verified completion after new activity or checkout movement', () => {
    const candidate = {
      ...session(
        'machine-a',
        'thread-a',
        '/worktrees/project-space/issue-177',
        'idle'
      ),
      lastActivityAt: '2026-07-13T23:58:00.000Z'
    };
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const evidence = {
      machineId: 'machine-a',
      threadId: 'thread-a',
      verification: {
        headSha: 'a'.repeat(40),
        sessionLastActivityAt: candidate.lastActivityAt,
        verifiedAt: '2026-07-13T23:59:00.000Z'
      }
    };
    const delivery = (lastActivityAt: string, headSha: string) => snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': {
          checkedAt,
          data: codex('machine-a', [{ ...candidate, lastActivityAt }]),
          state: 'ready'
        }
      },
      taskEvidence: { [taskId]: evidence },
      worktreesByProject: {
        'project-a': worktrees('/projects/project-space', [{
          branchName: 'issue-177',
          headSha,
          id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
          path: '/worktrees/project-space/issue-177'
        }])
      }
    }))).projects[0]!.machines[0]!.tasks[0]!.delivery;

    expect(delivery(candidate.lastActivityAt, 'a'.repeat(40))).toBe('verified-complete');
    expect(delivery('2026-07-13T23:59:30.000Z', 'a'.repeat(40))).toBe('unknown');
    expect(delivery(candidate.lastActivityAt, 'b'.repeat(40))).toBe('unknown');
  });

  test('rejects malformed, future, and pre-activity verification timestamps', () => {
    const candidate = {
      ...session('machine-a', 'thread-a', '/projects/project-space', 'idle'),
      lastActivityAt: '2026-07-13T23:59:00.000Z'
    };
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const delivery = (verifiedAt: string) => snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      taskEvidence: {
        [taskId]: {
          machineId: 'machine-a',
          threadId: 'thread-a',
          verification: {
            sessionLastActivityAt: candidate.lastActivityAt,
            verifiedAt
          }
        }
      }
    }))).projects[0]!.machines[0]!.tasks[0]!.delivery;

    expect(delivery('not-a-date')).toBe('unknown');
    expect(delivery('2026-07-14T00:01:00.000Z')).toBe('unknown');
    expect(delivery('2026-07-13T23:58:00.000Z')).toBe('unknown');
    expect(delivery('2026-07-13T23:59:30.000Z')).toBe('verified-complete');
  });

  test('reports archived activity only from the real Codex session state', () => {
    const candidate = session(
      'machine-a',
      'thread-a',
      '/projects/project-space',
      'archived'
    );
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      }
    })));
    const task = result.projects[0]!.machines[0]!.tasks[0]!;

    expect(task.activity).toBe('archived');
    expect(task.interaction.composerVisible).toBe(false);
  });

  test('advances through verified, merged, and deployed delivery with exact evidence', () => {
    const branchName = 'issue-177';
    const headSha = 'b'.repeat(40);
    const mergeSha = 'c'.repeat(40);
    const candidate = {
      ...session(
        'machine-a',
        'thread-a',
        '/worktrees/project-space/issue-177',
        'idle'
      ),
      lastActivityAt: '2026-07-13T23:58:00.000Z'
    };
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const delivery = (stage: 'verified' | 'merged' | 'deployed') => {
      const details = {
        ...repositoryDetails(branchName),
        pullRequests: stage === 'verified' ? [] : [{
          headBranch: branchName,
          linkedIssueNumbers: [177],
          mergeCommitHash: mergeSha,
          number: 201,
          state: 'merged' as const,
          title: 'Implement topology command center',
          url: 'https://github.com/DotNaos/project-space/pull/201'
        }]
      };
      return snapshot(buildProjectTopology(inventory({
        codexByMachine: {
          'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
        },
        deployments: stage === 'deployed' ? {
          'DotNaos/project-space': {
            checkedAt,
            data: {
              checkedAt,
              environments: [{
                deployedSha: mergeSha,
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
        } : {},
        repositories: {
          'DotNaos/project-space': { checkedAt, data: details, state: 'ready' }
        },
        taskEvidence: {
          [taskId]: {
            ...(stage === 'verified' ? {} : {
              delivery: {
                branchName,
                headSha,
                mergeCommitHash: mergeSha,
                observedAt: '2026-07-13T23:59:30.000Z',
                pullRequestNumber: 201,
                sessionLastActivityAt: candidate.lastActivityAt,
                source: 'github-pull-request'
              }
            }),
            machineId: 'machine-a',
            threadId: 'thread-a',
            verification: {
              headSha,
              sessionLastActivityAt: candidate.lastActivityAt,
              verifiedAt: '2026-07-13T23:59:00.000Z'
            }
          }
        },
        worktreesByProject: {
          'project-a': worktrees('/projects/project-space', [{
            branchName,
            headSha,
            id: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa',
            path: '/worktrees/project-space/issue-177'
          }])
        }
      }))).projects[0]!.machines[0]!.tasks[0]!.delivery;
    };

    expect(delivery('verified')).toBe('verified-complete');
    expect(delivery('merged')).toBe('merged');
    expect(delivery('deployed')).toBe('deployed');
  });

  test('keeps missing machine evidence limited and never exposes its composer', () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const taskId = topologyTaskId('machine-a', 'thread-a');
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: {
        'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
      },
      conversations: {
        [taskId]: {
          checkedAt,
          data: { openedReadOnly: true, session: candidate, turns: [] },
          state: 'ready'
        }
      },
      machines: []
    })));
    const machine = result.projects[0]!.machines[0]!;

    expect(machine.inventory.state).toBe('limited');
    expect(machine.tasks[0]!.interaction.composerVisible).toBe(false);
  });

  test('never describes checking task inventory as an empty result', () => {
    const result = snapshot(buildProjectTopology(inventory({
      codexByMachine: { 'machine-a': { state: 'checking' } }
    })));

    expect(result.projects[0]!.machines[0]!.taskInventory.state).toBe('checking');
    expect(result.summary.tasks).toEqual({ completeness: 'unknown', observedCount: 0 });
  });
});
