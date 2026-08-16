import { describe, expect, test } from 'bun:test';
import type { CodexSession } from '../src/features/codex-sessions/codex-sessions-types';
import {
  codexTasksForIssue,
  projectTaskPipelinePresentation
} from '../src/features/project-tasks/project-task-runtime-model';

const project = {
  id: 'project-space',
  kind: 'github' as const,
  machineId: 'machine-1',
  name: 'project-space',
  rootPath: '/Users/oli/projects/project-space'
};

function session(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    cwd: '/Users/oli/projects/.worktrees/project-space/issue-479-chat',
    lastActivityAt: '2026-08-16T10:00:00.000Z',
    loadedByProjectSpace: true,
    machineId: 'machine-1',
    status: 'idle',
    stored: true,
    taskIdentity: { issueNumber: 479, repository: 'DotNaos/project-space' },
    threadId: '01a00c12-3ac1-7e71-8545-62de0007e267',
    title: '#479 · Hera · Redesign Project Chat',
    ...overrides
  };
}

describe('project task runtime panels', () => {
  test('selects only Codex tasks for the current issue and project scope', () => {
    const tasks = codexTasksForIssue({
      issueNumber: 479,
      project,
      sessions: [
        session(),
        session({ taskIdentity: { issueNumber: 732 }, threadId: '01a00c12-3ac1-7e71-8545-62de0007e268' }),
        session({ machineId: 'machine-2', threadId: '01a00c12-3ac1-7e71-8545-62de0007e269' })
      ]
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.issueNumber).toBe(479);
    expect(tasks[0]?.title).toBe('Hera · Redesign Project Chat');
  });

  test('presents native task workflow truth', () => {
    expect(projectTaskPipelinePresentation({ health: 'healthy' })).toEqual({
      color: 'success',
      label: 'Checks passed'
    });
    expect(projectTaskPipelinePresentation({
      health: 'unknown',
      pipeline: { id: 803, status: 'in_progress', kind: 'ci' },
      pullRequest: { number: 803, state: 'open', title: 'Chat', url: 'https://example.test/803' }
    })).toEqual({ color: 'warning', label: 'Checks running' });
    expect(projectTaskPipelinePresentation({ health: 'attention' })).toEqual({
      color: 'danger',
      label: 'Checks failed'
    });
  });
});
