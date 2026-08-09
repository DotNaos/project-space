import { createHash } from 'node:crypto';
import { resolveLocalProjectPath } from '../local-project-identity';
import { resolveLocalProjectWorktree } from '../local-project-worktrees';
import type {
  WorkspaceCommandConnectorAdapter,
  WorkspaceCommandConnectorRequest,
  WorkspaceCommandConnectorResult
} from './connector-contract';
import { startWorkspaceSandbox, type WorkspaceSandboxExecution } from './sandbox-runner';

type TrustedCommandRequest = WorkspaceCommandConnectorRequest & {
  actor: { generation: number; userId: string };
};

interface ActiveCommand {
  execution: WorkspaceSandboxExecution;
  request: TrustedCommandRequest;
  result: WorkspaceCommandConnectorResult;
}

function sameCommandIdentity(
  left: TrustedCommandRequest,
  right: TrustedCommandRequest
) {
  return left.actor.generation === right.actor.generation &&
    left.actor.userId === right.actor.userId && left.allowNetwork === right.allowNetwork &&
    left.commandId === right.commandId && left.commandSha256 === right.commandSha256 &&
    left.environmentId === right.environmentId && left.executionId === right.executionId &&
    left.expectedHeadSha === right.expectedHeadSha && left.machineId === right.machineId &&
    left.maxOutputBytes === right.maxOutputBytes && left.projectId === right.projectId &&
    left.repositoryWritable === right.repositoryWritable &&
    left.timeoutSeconds === right.timeoutSeconds && left.workspaceId === right.workspaceId &&
    left.workspaceWritable === right.workspaceWritable && left.worktreeId === right.worktreeId;
}

export function createLocalWorkspaceCommandAdapter(options: {
  resolveProjectPath?: typeof resolveLocalProjectPath;
  resolveWorktree?: typeof resolveLocalProjectWorktree;
  startSandbox?: typeof startWorkspaceSandbox;
} = {}): WorkspaceCommandConnectorAdapter {
  const commands = new Map<string, ActiveCommand>();
  const resolveProject = options.resolveProjectPath ?? resolveLocalProjectPath;
  const resolveWorktree = options.resolveWorktree ?? resolveLocalProjectWorktree;
  const run = options.startSandbox ?? startWorkspaceSandbox;

  function snapshot(request: WorkspaceCommandConnectorRequest, state: WorkspaceCommandConnectorResult['state'], message = ''): WorkspaceCommandConnectorResult {
    return {
      checkedAt: new Date().toISOString(), commandId: request.commandId,
      environmentId: request.environmentId, executionId: request.executionId,
      generation: 0, machineId: request.machineId, operation: request.operation,
      state, stderr: message, stdout: '', truncated: false, workspaceId: request.workspaceId
    };
  }

  return {
    async execute(request) {
      const cutoff = Date.now() - 24 * 60 * 60_000;
      for (const [id, value] of commands) {
        if (value.result.finishedAt && Date.parse(value.result.finishedAt) < cutoff) commands.delete(id);
      }
      const current = commands.get(request.commandId);
      if (current) {
        if (!sameCommandIdentity(current.request, request))
          throw new Error('Workspace command identity changed.');
        if (request.operation === 'cancel' && ['queued', 'running'].includes(current.result.state))
          current.execution.cancel();
        return { ...current.result, checkedAt: new Date().toISOString(),
          generation: request.actor.generation, operation: request.operation };
      }
      if (request.operation !== 'start') {
        return { ...snapshot(request, 'uncertain', 'The connector no longer has this command.'),
          generation: request.actor.generation };
      }
      if (commands.size >= 256) {
        return {
          ...snapshot(request, 'unsupported', 'The connector command limit is reached.'),
          generation: request.actor.generation
        };
      }
      if (!request.command || createHash('sha256').update(request.command).digest('hex') !== request.commandSha256)
        throw new Error('Workspace command digest does not match.');
      try {
        const projectPath = await resolveProject(request.machineId, request.projectId);
        const worktree = await resolveWorktree(projectPath, request.worktreeId, {
          expectedHeadSha: request.expectedHeadSha
        });
        const execution = await run({
          allowNetwork: request.allowNetwork, command: request.command,
          maxOutputBytes: request.maxOutputBytes, timeoutSeconds: request.timeoutSeconds,
          repositoryWritable: request.repositoryWritable, workspacePath: worktree.path,
          workspaceWritable: request.workspaceWritable
        });
        const running: WorkspaceCommandConnectorResult = {
          ...snapshot(request, 'running'), generation: request.actor.generation,
          startedAt: new Date().toISOString()
        };
        const active = { execution, request, result: running };
        commands.set(request.commandId, active);
        void execution.completion.then((finished) => {
          active.result = {
            ...running, ...finished, checkedAt: new Date().toISOString(), operation: 'status'
          };
        });
        return running;
      } catch (error) {
        return {
          ...snapshot(request, 'unsupported', error instanceof Error ? error.message : 'Workspace isolation is unavailable.'),
          generation: request.actor.generation
        };
      }
    }
  };
}
