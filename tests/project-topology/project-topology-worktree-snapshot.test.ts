import { describe, expect, test } from 'bun:test';

import {
  parseProjectTopologyWorktreeSnapshot,
  type ProjectTopologyWorktreeSnapshot
} from '../../src/shared/project-topology-api';
import { checkedAt, project, worktrees } from './project-topology-test-fixtures';

describe('project topology worktree snapshot contract', () => {
  test('accepts exact multi-machine project scopes', () => {
    const value = snapshot();
    const second = project('project-a', 'machine-b', '/machine-b/project-space');
    value.projectDiscovery.projects.push(second);
    value.worktrees.push({
      machineId: second.machineId,
      projectId: second.id,
      result: worktrees(second.rootPath, [])
    });

    expect(parseProjectTopologyWorktreeSnapshot(value).worktrees).toHaveLength(2);
  });

  test('rejects omitted, extra, duplicate, and wrong-path scopes', () => {
    const omitted = snapshot();
    omitted.worktrees = [];
    const extra = snapshot();
    extra.worktrees.push({
      machineId: 'machine-b',
      projectId: 'hidden',
      result: worktrees('/hidden', [])
    });
    const duplicate = snapshot();
    duplicate.worktrees.push({ ...duplicate.worktrees[0]! });
    const wrongPath = snapshot();
    wrongPath.worktrees[0]!.result = worktrees('/different-root', []);

    for (const candidate of [omitted, extra, duplicate, wrongPath]) {
      expect(() => parseProjectTopologyWorktreeSnapshot(candidate)).toThrow('malformed');
    }
  });

  test('rejects contradictory state shapes and future evidence', () => {
    const readyEmpty = snapshot();
    readyEmpty.worktrees[0]!.result = {
      ...worktrees('/projects/project-space', []),
      state: 'ready'
    } as never;
    const emptyNonempty = snapshot();
    emptyNonempty.worktrees[0]!.result = {
      ...worktrees('/projects/project-space', [{
        branchName: 'main', id: 'wt', isBase: true, path: '/projects/project-space'
      }]),
      state: 'proven-empty'
    } as never;
    const future = snapshot();
    const result = future.worktrees[0]!.result;
    if (result.state !== 'blocked') {
      result.evidence.checkedAt = '2026-07-14T00:00:01.000Z';
    }
    const missingAuthorization = {
      ...snapshot(),
      authorization: undefined
    } as never;
    const mismatchedAuthorization = snapshot();
    mismatchedAuthorization.authorization.projectDiscoveryCheckedAt =
      '2026-07-13T23:59:59.000Z';

    for (const candidate of [
      readyEmpty,
      emptyNonempty,
      future,
      missingAuthorization,
      mismatchedAuthorization
    ]) {
      expect(() => parseProjectTopologyWorktreeSnapshot(candidate)).toThrow('malformed');
    }
  });
});

function snapshot(): ProjectTopologyWorktreeSnapshot {
  const record = project('project-a', 'machine-a', '/projects/project-space');
  return {
    authorization: {
      connectorOverviewCheckedAt: checkedAt,
      projectDiscoveryCheckedAt: checkedAt
    },
    checkedAt,
    publishedAt: checkedAt,
    projectDiscovery: {
      groups: [],
      projects: [record],
      rootItems: [],
      rootPath: '/projects',
      structureViolations: []
    },
    worktrees: [{
      machineId: record.machineId,
      projectId: record.id,
      result: worktrees(record.rootPath, [])
    }]
  };
}
