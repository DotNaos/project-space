import { createHash } from 'node:crypto';

import type {
  CodexMachineTaskConnectorStartRequest,
  CodexMachineTaskConnectorStartResult
} from '../../src/shared/codex-machine-tasks-api';
import { CodexOperationUncertainError, type CodexSessionManager } from '../codex-sessions';
import { startTurnWithReadReconciliation } from '../codex-sessions/reconciled-turn-start';
import { createLocalWorktreeActionAdapter } from '../local-worktree-action-adapter';
import { loadLocalProjectWorktrees } from '../local-project-worktrees';
import { runProjectBinary } from '../local-project-cli-client';

export function createLocalCodexMachineTaskStarter(
  manager: CodexSessionManager,
  dependencies: {
    loadWorktrees?: typeof loadLocalProjectWorktrees;
    runProject?: typeof runProjectBinary;
    worktreeAdapter?: ReturnType<typeof createLocalWorktreeActionAdapter>;
  } = {}
) {
  const adapter = dependencies.worktreeAdapter ?? createLocalWorktreeActionAdapter();
  const loadWorktrees = dependencies.loadWorktrees ?? loadLocalProjectWorktrees;
  const runProject = dependencies.runProject ?? runProjectBinary;

  return async function start(
    request: CodexMachineTaskConnectorStartRequest,
    actor: { generation: number; userId: string }
  ): Promise<CodexMachineTaskConnectorStartResult> {
    const materialized = await adapter.runWorktreeAction({
      actor,
      branchName: request.branch,
      commitSha: request.commit,
      machineId: request.machineId,
      operation: 'materialize',
      projectId: request.projectId,
      repositoryFullName: request.repositoryNameWithOwner
    });
    if (
      materialized.operation !== 'materialize' ||
      materialized.state === 'error' ||
      !materialized.projectPath ||
      !materialized.worktreePath
    ) {
      return {
        message: 'Worktree materialization failed on the selected connector.',
        state: 'worktree_failure'
      };
    }

    try {
      const thread = await manager.startThread({
        cwd: materialized.worktreePath,
        operationId: derivedOperationId(request.operationId, 'thread')
      });
      const threadId = thread.thread.id;
      const claimed = await runProject(
        ['worktree', 'prepare', '--format', 'json'],
        materialized.worktreePath,
        {
          environment: { CODEX_THREAD_ID: threadId },
          timeoutMs: 60_000
        }
      );
      if (claimed.exitCode !== 0) {
        return {
          message: 'The Project-managed worktree could not be claimed.',
          state: 'worktree_failure'
        };
      }
      const claim = readClaim(claimed.stdout);
      if (
        !claim || claim.ownerThreadId !== threadId || claim.path !== materialized.worktreePath ||
        claim.branch !== request.branch || !['claimed', 'ready'].includes(claim.status)
      ) {
        return {
          message: 'The Project-managed worktree claim could not be verified.',
          state: 'worktree_failure'
        };
      }
      const worktree = (await loadWorktrees(materialized.projectPath)).find((candidate) => (
        candidate.path === materialized.worktreePath &&
        candidate.branchName === request.branch &&
        candidate.headSha === request.commit &&
        candidate.isBase === false &&
        candidate.kind === 'project-managed' &&
        candidate.status === 'ready'
      ));
      if (!worktree) {
        return {
          message: 'The isolated Project-managed worktree could not be verified.',
          state: 'worktree_failure'
        };
      }
      await startTurnWithReadReconciliation(manager, {
        operationId: derivedOperationId(request.operationId, 'turn'),
        prompt: request.initialPrompt,
        threadId
      });
      return { state: 'confirmed', threadId, worktreeId: worktree.id };
    } catch (error) {
      if (error instanceof CodexOperationUncertainError) return { state: 'uncertain' };
      return { state: 'uncertain' };
    }
  };
}

function derivedOperationId(operationId: string, step: string) {
  const digest = createHash('sha256').update(`${step}\0${operationId}`).digest('hex').slice(0, 32);
  return `task:${step}:${digest}`;
}

function readClaim(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.ownerThreadId !== 'string' || typeof parsed.path !== 'string' ||
      typeof parsed.branch !== 'string' || typeof parsed.status !== 'string'
    ) return undefined;
    return {
      branch: parsed.branch,
      ownerThreadId: parsed.ownerThreadId,
      path: parsed.path,
      status: parsed.status
    };
  } catch {
    return undefined;
  }
}
