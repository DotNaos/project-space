import { describe, expect, test } from 'bun:test';

import {
  devServerKey,
  runtimeRowsForWorktrees,
  startDevServerBatch,
  startableDevServers,
  unmaterializedBranchesFor
} from '../src/features/project-desktop/components/worktree-runtime-model';
import type {
  ProjectWorktreeRecord,
  WorktreeDevServerRecord
} from '../src/shared/project-space-api';
import type { WorktreeSetupResult } from '../src/shared/worktree-action-api';

const worktrees: ProjectWorktreeRecord[] = [
  {
    branchName: 'Feature/Case',
    detached: false,
    headSha: 'a'.repeat(40),
    id: 'wt_111111111111111111111111',
    isBase: false,
    kind: 'project-managed',
    locked: false,
    name: 'case-upper',
    path: '/connector/private/a',
    prunable: false,
    status: 'ready'
  },
  {
    branchName: 'feature/case',
    detached: false,
    headSha: 'b'.repeat(40),
    id: 'wt_222222222222222222222222',
    isBase: false,
    kind: 'project-managed',
    locked: false,
    name: 'case-lower',
    path: '/connector/private/b',
    prunable: false,
    status: 'ready'
  },
  {
    detached: true,
    headSha: 'c'.repeat(40),
    id: 'wt_333333333333333333333333',
    isBase: false,
    kind: 'codex',
    locked: false,
    name: 'Codex · a281 · ccccccc',
    path: '/connector/private/detached',
    prunable: false,
    status: 'ready'
  }
];

describe('worktree runtime model', () => {
  test('keeps case-distinct and detached worktrees as stable-ID rows', () => {
    const rows = runtimeRowsForWorktrees(worktrees);

    expect(rows.map((row) => row.worktree.id)).toEqual([
      'wt_111111111111111111111111',
      'wt_222222222222222222222222',
      'wt_333333333333333333333333'
    ]);
    expect(rows.map((row) => row.label)).toEqual([
      'Feature/Case',
      'feature/case',
      'Codex · a281 · ccccccc'
    ]);
  });

  test('keeps branch matching case-sensitive and detached-safe for creation', () => {
    expect(
      unmaterializedBranchesFor(
        ['Feature/Case', 'feature/case', 'FEATURE/CASE', 'new-branch'],
        worktrees
      )
    ).toEqual(['FEATURE/CASE', 'new-branch']);
  });

  test('starts only uniquely proven configured servers with ready setup', () => {
    const configured = (overrides: Partial<WorktreeDevServerRecord> = {}): WorktreeDevServerRecord => ({
      capability: 'configured',
      checkedAt: '2026-07-14T00:00:00.000Z',
      machineId: 'machine-1',
      projectId: 'project-1',
      runTarget: 'web',
      serverId: 'web',
      serverLabel: 'Web',
      state: 'stopped',
      worktreeId: worktrees[0]!.id,
      ...overrides
    });
    const readySetup: WorktreeSetupResult = {
      capability: 'configured',
      checkedAt: '2026-07-14T00:00:00.000Z',
      machineId: 'machine-1',
      projectId: 'project-1',
      steps: [],
      worktreeId: worktrees[0]!.id
    };
    const candidates = [
      configured(),
      configured(),
      configured({ serverId: 'api', serverLabel: 'API', state: 'error' }),
      configured({ serverId: 'running', state: 'running' }),
      configured({ serverId: 'missing', worktreeId: worktrees[1]!.id }),
      configured({ capability: 'unavailable', serverId: 'unavailable' })
    ];

    const startable = startableDevServers(
      candidates,
      worktrees,
      new Map([[worktrees[0]!.id, readySetup]])
    );

    expect(startable.map(devServerKey)).toEqual([
      `${worktrees[0]!.id}\u0000web`,
      `${worktrees[0]!.id}\u0000api`
    ]);
  });

  test('continues after partial start failures and reports each server', async () => {
    const servers = ['Web', 'API', 'Docs'].map((serverLabel, index) => ({
      capability: 'configured' as const,
      checkedAt: '2026-07-14T00:00:00.000Z',
      machineId: 'machine-1',
      projectId: 'project-1',
      runTarget: 'web',
      serverId: serverLabel.toLowerCase(),
      serverLabel,
      state: 'stopped' as const,
      worktreeId: worktrees[index]!.id
    }));
    const attempted: string[] = [];
    const results = await startDevServerBatch(servers, async (server) => {
      attempted.push(server.serverId);
      if (server.serverId === 'api') throw new Error('Port is already in use.');
      return { status: 'started' };
    });

    expect(attempted).toEqual(['web', 'api', 'docs']);
    expect(results.map(({ serverLabel, status, message }) => ({ serverLabel, status, message }))).toEqual([
      { message: undefined, serverLabel: 'Web', status: 'started' },
      { message: 'Port is already in use.', serverLabel: 'API', status: 'failed' },
      { message: undefined, serverLabel: 'Docs', status: 'started' }
    ]);
  });
});
