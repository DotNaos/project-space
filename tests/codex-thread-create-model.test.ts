import { describe, expect, test } from 'bun:test';
import type { CodexHostInventoryItem } from '../src/shared/codex-host-inventory-api';
import {
  codexHostWorktrees,
  issueBoundCodexWorktree
} from '../src/features/codex-sessions/codex-thread-create-model';

const host: CodexHostInventoryItem = {
  addresses: ['100.80.135.9'],
  machineId: 'os-macbook',
  name: 'os-macbook',
  tailscaleDeviceId: 'device-1',
  worktrees: [{
    branch: 'issue-479-redesign-chat',
    issueNumber: 479,
    label: 'issue-479-redesign-chat',
    path: '/Users/oli/projects/.worktrees/project-space/issue-479-redesign-chat',
    repository: 'DotNaos/project-space',
    threadCount: 2
  }, {
    branch: 'issue-763-supported-task-start',
    issueNumber: 763,
    label: 'issue-763-supported-task-start',
    path: '/Users/oli/projects/.worktrees/project-space/issue-763-supported-task-start',
    repository: 'DotNaos/project-space',
    threadCount: 1
  }]
};

describe('Codex thread create worktree model', () => {
  test('keeps the full host-scoped catalogue for the general Chat page', () => {
    expect(codexHostWorktrees(host)).toEqual(host.worktrees);
  });

  test('binds an issue to exactly its own repository and branch worktree', () => {
    expect(issueBoundCodexWorktree(host, {
      branch: 'issue-763-supported-task-start',
      issueNumber: 763,
      repository: 'DotNaos/project-space'
    })?.path).toBe(
      '/Users/oli/projects/.worktrees/project-space/issue-763-supported-task-start'
    );
  });

  test('fails closed instead of selecting another issue worktree', () => {
    expect(issueBoundCodexWorktree(host, {
      branch: 'issue-999-missing',
      issueNumber: 999,
      repository: 'DotNaos/project-space'
    })).toBeUndefined();
    expect(issueBoundCodexWorktree(host, {
      branch: 'issue-763-supported-task-start',
      issueNumber: 763,
      repository: 'DotNaos/another-project'
    })).toBeUndefined();
  });

  test('fails closed when duplicate task identity evidence is ambiguous', () => {
    expect(issueBoundCodexWorktree({
      ...host,
      worktrees: [host.worktrees[1]!, {
        ...host.worktrees[1]!,
        path: '/Users/oli/projects/.worktrees/project-space/duplicate'
      }]
    }, {
      branch: 'issue-763-supported-task-start',
      issueNumber: 763,
      repository: 'DotNaos/project-space'
    })).toBeUndefined();
  });
});
