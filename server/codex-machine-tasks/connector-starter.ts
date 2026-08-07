import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import type {
  CodexMachineTaskConnectorStartRequest,
  CodexMachineTaskConnectorStartResult
} from '../../src/shared/codex-machine-tasks-api';
import {
  CodexAppServerRequestError,
  CodexOperationUncertainError,
  CodexThreadUnmaterializedError,
  type CodexSessionManager,
  validateIdentifier
} from '../codex-sessions';
import { startTurnWithReadReconciliation } from '../codex-sessions/reconciled-turn-start';
import { createLocalWorktreeActionAdapter } from '../local-worktree-action-adapter';
import { loadLocalProjectWorktrees } from '../local-project-worktrees';
import { runProjectBinary } from '../local-project-cli-client';
import { projectSpaceLogger, recordObservedError } from '../observability';

const execFileAsync = promisify(execFile);

export function createLocalCodexMachineTaskStarter(
  manager: CodexSessionManager,
  dependencies: {
    loadWorktrees?: typeof loadLocalProjectWorktrees;
    readWorktreeOwner?: typeof readProjectWorktreeOwner;
    runProject?: typeof runProjectBinary;
    worktreeAdapter?: ReturnType<typeof createLocalWorktreeActionAdapter>;
  } = {}
) {
  const adapter = dependencies.worktreeAdapter ?? createLocalWorktreeActionAdapter();
  const loadWorktrees = dependencies.loadWorktrees ?? loadLocalProjectWorktrees;
  const readWorktreeOwner = dependencies.readWorktreeOwner ?? readProjectWorktreeOwner;
  const runProject = dependencies.runProject ?? runProjectBinary;

  return async function start(
    request: CodexMachineTaskConnectorStartRequest,
    actor: { generation: number; userId: string }
  ): Promise<CodexMachineTaskConnectorStartResult> {
    let materialized: Awaited<ReturnType<typeof adapter.runWorktreeAction>>;
    try {
      materialized = await adapter.runWorktreeAction({
        actor,
        branchName: request.branch,
        commitSha: request.commit,
        machineId: request.machineId,
        operation: 'materialize',
        projectId: request.projectId,
        repositoryFullName: request.repositoryNameWithOwner
      });
    } catch (error) {
      recordObservedError('codex_machine_task', 'materialization_failed');
      projectSpaceLogger.error('codex_machine_task.materialization.failed', {
        component: 'codex-machine-task',
        issueNumber: request.issueNumber,
        operationId: request.operationId
      }, error);
      return {
        message: 'Worktree materialization failed on the selected connector.',
        state: 'worktree_failure'
      };
    }
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

      const existingOwnerThreadId = await readWorktreeOwner(materialized.worktreePath);
      if (existingOwnerThreadId) {
        const resumed = await resumeExistingTaskThread(manager, {
          initialPrompt: request.initialPrompt,
          operationId: request.operationId,
          threadId: existingOwnerThreadId,
          worktreePath: materialized.worktreePath
        });
        if (resumed === 'different') {
          return {
            message: 'The Project-managed worktree belongs to a different Codex task.',
            state: 'worktree_failure'
          };
        }
        if (resumed === 'missing') {
          return await recoverOrphanedTaskThread(manager, runProject, {
            existingOwnerThreadId,
            initialPrompt: request.initialPrompt,
            operationId: request.operationId,
            requestBranch: request.branch,
            worktreeId: worktree.id,
            worktreePath: materialized.worktreePath
          });
        }
        return {
          state: 'confirmed',
          threadId: existingOwnerThreadId,
          worktreeId: worktree.id
        };
      }

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
          message: worktreeClaimFailureMessage(claimed.stderr),
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
      await startTurnWithReadReconciliation(manager, {
        operationId: derivedOperationId(request.operationId, 'turn'),
        prompt: request.initialPrompt,
        threadId
      });
      return { state: 'confirmed', threadId, worktreeId: worktree.id };
    } catch (error) {
      if (error instanceof CodexOperationUncertainError) return { state: 'uncertain' };
      recordObservedError('codex_machine_task', 'start_failed');
      projectSpaceLogger.error('codex_machine_task.start.failed', {
        component: 'codex-machine-task',
        rpcCode: error instanceof CodexAppServerRequestError ? error.rpcCode : undefined,
        rpcReason: error instanceof CodexAppServerRequestError ? error.rpcReason : undefined,
        rpcTags: error instanceof CodexAppServerRequestError ? error.rpcTags : undefined,
        issueNumber: request.issueNumber,
        operationId: request.operationId
      }, error);
      return {
        message: 'Codex could not start on the selected connector. You can retry safely.',
        state: 'codex_failure'
      };
    }
  };
}

async function readProjectWorktreeOwner(worktreePath: string) {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', worktreePath, 'config', '--worktree', '--get', 'project.codexThreadId'],
      { maxBuffer: 16_384, timeout: 10_000 }
    );
    const threadId = String(stdout).trim();
    return threadId ? validateIdentifier(threadId, 'threadId') : undefined;
  } catch (error) {
    if (
      error && typeof error === 'object' &&
      'code' in error && (error as { code?: unknown }).code === 1
    ) return undefined;
    throw error;
  }
}

async function resumeExistingTaskThread(
  manager: CodexSessionManager,
  input: {
    initialPrompt: string;
    operationId: string;
    threadId: string;
    worktreePath: string;
  }
) {
  let thread: Awaited<ReturnType<CodexSessionManager['readThread']>>['thread'] | undefined;
  try {
    thread = (await manager.readThread(input.threadId, true)).thread;
  } catch (error) {
    if (error instanceof CodexThreadUnmaterializedError) {
      thread = undefined;
    } else if (error instanceof CodexAppServerRequestError && error.rpcCode === -32600) {
      return 'missing' as const;
    } else {
      throw error;
    }
  }
  if (thread) {
    if (thread.cwd && thread.cwd !== input.worktreePath) return 'different' as const;
    if (threadContainsPrompt(thread.turns, input.initialPrompt)) return 'resumed' as const;
    if (Array.isArray(thread.turns) && thread.turns.length > 0) return 'different' as const;
    if (thread.status?.type === 'active' || thread.status?.type === 'systemError') {
      return 'different' as const;
    }
  }
  await startTurnWithReadReconciliation(manager, {
    operationId: derivedOperationId(input.operationId, 'turn'),
    prompt: input.initialPrompt,
    threadId: input.threadId
  });
  return 'resumed' as const;
}

async function recoverOrphanedTaskThread(
  manager: CodexSessionManager,
  runProject: typeof runProjectBinary,
  input: {
    existingOwnerThreadId: string;
    initialPrompt: string;
    operationId: string;
    requestBranch: string;
    worktreeId: string;
    worktreePath: string;
  }
): Promise<CodexMachineTaskConnectorStartResult> {
  const replacement = await manager.startThread({
    cwd: input.worktreePath,
    operationId: derivedOperationId(input.operationId, 'replacement-thread')
  });
  const replacementThreadId = replacement.thread.id;
  const recovered = await runProject(
    [
      'worktree',
      'recover',
      '--expected-owner',
      input.existingOwnerThreadId,
      '--format',
      'json'
    ],
    input.worktreePath,
    {
      environment: { CODEX_THREAD_ID: replacementThreadId },
      timeoutMs: 60_000
    }
  );
  if (recovered.exitCode !== 0) {
    return {
      message: worktreeRecoveryFailureMessage(recovered.stderr),
      state: 'worktree_failure'
    };
  }
  const claim = readClaim(recovered.stdout);
  if (
    !claim || claim.ownerThreadId !== replacementThreadId ||
    claim.path !== input.worktreePath || claim.branch !== input.requestBranch ||
    claim.status !== 'recovered'
  ) {
    return {
      message: 'The orphaned Project-managed worktree recovery could not be verified.',
      state: 'worktree_failure'
    };
  }
  await startTurnWithReadReconciliation(manager, {
    operationId: derivedOperationId(input.operationId, 'turn'),
    prompt: input.initialPrompt,
    threadId: replacementThreadId
  });
  return {
    state: 'confirmed',
    threadId: replacementThreadId,
    worktreeId: input.worktreeId
  };
}

function threadContainsPrompt(turns: unknown[] | undefined, prompt: string) {
  return (turns ?? []).some((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const items = (value as { items?: unknown }).items;
    if (!Array.isArray(items)) return false;
    return items.some((itemValue) => {
      if (!itemValue || typeof itemValue !== 'object' || Array.isArray(itemValue)) return false;
      const item = itemValue as { content?: unknown; type?: unknown };
      if (item.type !== 'userMessage' || !Array.isArray(item.content)) return false;
      return item.content.flatMap((contentValue) => {
        if (!contentValue || typeof contentValue !== 'object' || Array.isArray(contentValue)) {
          return [];
        }
        const content = contentValue as { text?: unknown; type?: unknown };
        return content.type === 'text' && typeof content.text === 'string' ? [content.text] : [];
      }).join('') === prompt;
    });
  });
}

function derivedOperationId(operationId: string, step: string) {
  const digest = createHash('sha256').update(`${step}\0${operationId}`).digest('hex').slice(0, 32);
  return `task:${step}:${digest}`;
}

function worktreeClaimFailureMessage(stderr: string) {
  const detail = stderr.toLowerCase();
  if (detail.includes('codex_thread_id') || detail.includes('codex thread identifier')) {
    return 'The connector returned an invalid Codex thread identity.';
  }
  if (detail.includes('belongs to codex thread')) {
    return 'The Project-managed worktree already belongs to another Codex thread.';
  }
  if (detail.includes('already owns worktree')) {
    return 'The Codex thread already owns a different Project-managed worktree.';
  }
  if (detail.includes('contains changes')) {
    return 'The unowned Project-managed worktree contains changes and was not claimed.';
  }
  if (detail.includes('head does not match')) {
    return 'The unowned Project-managed worktree does not match an approved remote branch.';
  }
  if (detail.includes('another worktree ownership operation')) {
    return 'Another Project worktree ownership operation is still active.';
  }
  if (detail.includes('main worktree is read-only')) {
    return 'The connector selected the read-only main worktree instead of an isolated checkout.';
  }
  if (detail.includes('dedicated non-main branch')) {
    return 'The materialized worktree does not have a dedicated non-main branch.';
  }
  if (detail.includes('project standard path')) {
    return 'The materialized worktree is outside the Project-managed worktree root.';
  }
  if (
    detail.includes('record worktree ownership') ||
    detail.includes('mark worktree as project-managed') ||
    detail.includes('enable worktree-specific configuration')
  ) {
    return 'Project could not record the worktree ownership metadata.';
  }
  return 'The Project-managed worktree could not be claimed.';
}

function worktreeRecoveryFailureMessage(stderr: string) {
  const detail = stderr.toLowerCase();
  if (detail.includes('contains changes')) {
    return 'The owned Project-managed worktree contains changes and was not recovered.';
  }
  if (detail.includes('head does not match')) {
    return 'The owned Project-managed worktree no longer matches its approved remote branch.';
  }
  if (detail.includes('owner no longer matches')) {
    return 'The Project-managed worktree owner changed before recovery completed.';
  }
  if (detail.includes('already owns worktree')) {
    return 'The replacement Codex thread already owns another Project-managed worktree.';
  }
  if (detail.includes('only a project-managed worktree')) {
    return 'The isolated checkout is no longer a Project-managed worktree.';
  }
  return 'The orphaned Project-managed worktree could not be safely recovered.';
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
