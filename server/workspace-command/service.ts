import { createHash } from 'node:crypto';
import type {
  CancelWorkspaceCommandRequest,
  GetWorkspaceCommandRequest,
  StartEnvironmentRecoveryCommandRequest,
  StartWorkspaceCommandRequest,
  WorkspaceCommandResult
} from '../../src/shared/workspace-command-api';
import type { ConfiguredComputeInventoryResult } from '../configured-compute-inventory';
import type { TaskExecutionOperationStore, TaskExecutionStore, TaskHandoffStore } from '../task-execution/contracts';
import {
  deterministicTaskExecutionId,
  taskExecutionFingerprint
} from '../task-execution/service-identity';
import type {
  WorkspaceCommandConnectorOperation,
  WorkspaceCommandConnectorRequest,
  WorkspaceCommandConnectorResult
} from './connector-contract';
import type { StoredWorkspaceCommand, WorkspaceCommandStore } from './contracts';

export interface WorkspaceCommandRecoveryProvider {
  cancel(command: StoredWorkspaceCommand): Promise<WorkspaceCommandConnectorResult>;
  resolve(input: { environmentId: string; operationId: string; userId: string }): Promise<{
    providerResourceId: string;
    state: 'ready' | 'unsupported';
  }>;
  start(command: StoredWorkspaceCommand, rawCommand: string): Promise<WorkspaceCommandConnectorResult>;
  status(command: StoredWorkspaceCommand): Promise<WorkspaceCommandConnectorResult>;
}

export interface WorkspaceCommandService {
  cancelRecovery(actor: { userId: string }, request: CancelWorkspaceCommandRequest): Promise<WorkspaceCommandResult>;
  cancelWorkspace(actor: { userId: string }, request: CancelWorkspaceCommandRequest): Promise<WorkspaceCommandResult>;
  get(actor: { userId: string }, request: GetWorkspaceCommandRequest): Promise<WorkspaceCommandResult>;
  startRecovery(
    actor: { userId: string },
    request: StartEnvironmentRecoveryCommandRequest,
    approve: () => Promise<boolean>
  ): Promise<WorkspaceCommandResult>;
  startWorkspace(actor: { userId: string }, request: StartWorkspaceCommandRequest): Promise<WorkspaceCommandResult>;
}

export interface WorkspaceCommandServiceDependencies {
  commands: WorkspaceCommandStore;
  dispatch(
    operation: WorkspaceCommandConnectorOperation,
    request: WorkspaceCommandConnectorRequest,
    actor: { generation: number; userId: string }
  ): Promise<WorkspaceCommandConnectorResult>;
  handoffs: TaskHandoffStore;
  inventory(userId: string): Promise<ConfiguredComputeInventoryResult>;
  now?: () => Date;
  operations: TaskExecutionOperationStore;
  recovery?: WorkspaceCommandRecoveryProvider;
  tasks: TaskExecutionStore;
}

export function createWorkspaceCommandService(
  dependencies: WorkspaceCommandServiceDependencies
): WorkspaceCommandService {
  const now = dependencies.now ?? (() => new Date());

  async function persistResult(
    command: StoredWorkspaceCommand,
    result: WorkspaceCommandConnectorResult
  ) {
    const stdout = safeOutput(result.stdout, command.maxOutputBytes);
    const stderr = safeOutput(result.stderr, command.maxOutputBytes - Buffer.byteLength(stdout));
    const persisted = await dependencies.commands.update({
      checkedAt: result.checkedAt, commandId: command.commandId,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
      ownerUserId: command.ownerUserId, ...(result.startedAt ? { startedAt: result.startedAt } : {}),
      state: result.state, stderr, stdout,
      truncated: result.truncated || stdout !== result.stdout || stderr !== result.stderr
    }) ?? command;
    if (terminal(persisted.state)) await finishStartOperation(persisted);
    return persisted;
  }

  async function invoke(
    command: StoredWorkspaceCommand,
    operation: WorkspaceCommandConnectorOperation,
    rawCommand?: string
  ) {
    try {
      const result = command.scope === 'workspace'
        ? await dependencies.dispatch(
            operation,
            connectorRequest(command, operation, rawCommand),
            { generation: command.connectorGeneration, userId: command.ownerUserId }
          )
        : operation === 'start'
          ? await dependencies.recovery!.start(command, rawCommand!)
          : operation === 'status'
            ? await dependencies.recovery!.status(command)
            : await dependencies.recovery!.cancel(command);
      return persistResult(command, result);
    } catch {
      return await dependencies.commands.update({
        checkedAt: now().toISOString(), commandId: command.commandId,
        ownerUserId: command.ownerUserId, state: 'uncertain'
      }) ?? command;
    }
  }

  async function finishOperation(
    command: StoredWorkspaceCommand,
    action: string,
    fingerprint: string,
    operationId: string
  ) {
    await dependencies.operations.transition({
      action, ...(command.executionId ? { executionId: command.executionId } : {}), fingerprint,
      operationId, ownerUserId: command.ownerUserId,
      result: { commandId: command.commandId, state: command.state },
      state: terminal(command.state) ? 'completed' : 'uncertain'
    });
  }

  async function finishStartOperation(command: StoredWorkspaceCommand) {
    await finishOperation(
      command,
      command.scope === 'workspace'
        ? 'start_workspace_command'
        : 'start_environment_recovery_command',
      command.startOperationFingerprint,
      command.startOperationId
    );
  }

  async function replayOrReconcile(
    actor: { userId: string },
    commandId: string,
    action: string,
    fingerprint: string,
    operationId: string,
    rawCommand?: string
  ) {
    const command = await dependencies.commands.read(actor.userId, commandId);
    if (!command) return undefined;
    if (terminal(command.state)) {
      await finishStartOperation(command);
      return project(command);
    }
    const reconciled = await invoke(command, 'status');
    if (terminal(reconciled.state)) await finishOperation(
      reconciled, action, fingerprint, operationId
    );
    return project(reconciled);
  }

  async function cancelCommand(
    actor: { userId: string },
    request: CancelWorkspaceCommandRequest,
    expectedScope: StoredWorkspaceCommand['scope']
  ) {
    const command = await dependencies.commands.read(actor.userId, request.commandId);
    if (!command) throw new Error('Workspace command was not found.');
    if (command.scope !== expectedScope) throw new Error('Workspace command scope does not match.');
    const action = expectedScope === 'workspace'
      ? 'cancel_workspace_command' : 'cancel_environment_recovery_command';
    const fingerprint = taskExecutionFingerprint({ action, ...request });
    const reservation = await dependencies.operations.reserve({
      action, ...(command.executionId ? { executionId: command.executionId } : {}), fingerprint,
      operationId: request.operationId, ownerUserId: actor.userId
    });
    if (reservation.kind === 'conflict') throw new Error('Operation ID belongs to another action.');
    if (terminal(command.state)) {
      await finishOperation(command, action, fingerprint, request.operationId);
      await finishStartOperation(command);
      return project(command);
    }
    if (reservation.kind === 'new') await dependencies.operations.claimDispatch({
      action, ...(command.executionId ? { executionId: command.executionId } : {}), fingerprint,
      operationId: request.operationId, ownerUserId: actor.userId
    });
    const cancelled = await invoke(command, reservation.kind === 'new' ? 'cancel' : 'status');
    await finishOperation(cancelled, action, fingerprint, request.operationId);
    return project(cancelled);
  }

  return {
    async startWorkspace(actor, request) {
      const limits = normalizeLimits(request);
      const fingerprint = taskExecutionFingerprint({ action: 'start_workspace_command', ...request, ...limits });
      const commandId = deterministicTaskExecutionId('workspace-command', actor.userId, request.operationId);
      const reservation = await dependencies.operations.reserve({
        action: 'start_workspace_command', executionId: request.executionId, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId
      });
      if (reservation.kind === 'conflict') throw new Error('Operation ID belongs to another command.');
      if (reservation.kind !== 'new') {
        const replay = await replayOrReconcile(
          actor, commandId, 'start_workspace_command', fingerprint, request.operationId, request.command
        );
        if (replay) return replay;
      }
      const execution = await dependencies.tasks.read(actor.userId, request.executionId);
      const workspace = await dependencies.tasks.readWorkspace(actor.userId, request.executionId);
      if (!execution || !workspace || workspace.state !== 'ready' || !execution.source.commit ||
          workspace.target?.kind !== 'project_worktree' ||
          !/^wt_[a-f0-9]{24}$/.test(workspace.target.reference) || !execution.connectorBinding)
        throw new Error('The exact runner workspace is unavailable.');
      if (execution.state === 'archived') throw new Error('Archived Task Executions cannot run commands.');
      const handoff = await dependencies.handoffs.read(
        actor.userId, execution.handoff.id, execution.handoff.revision
      );
      if (!handoff) throw new Error('The Task Handoff is unavailable.');
      const inventory = await dependencies.inventory(actor.userId);
      if (inventory.snapshot.violations.length > 0) throw new Error('Compute identity is ambiguous.');
      const associations = inventory.snapshot.connectors.filter(
        (entry) => entry.environmentId === execution.environmentId
      );
      const connector = inventory.connectors.find((entry) => entry.id === execution.connectorBinding!.connectorId);
      const generation = inventory.generations.get(execution.connectorBinding.connectorId);
      if (associations.length !== 1 || associations[0]?.connectorId !== execution.connectorBinding.connectorId ||
          generation !== execution.connectorBinding.generation || connector?.connector.status === 'offline' ||
          !connector?.connector.capabilities?.includes('workspace.commands.v1'))
        throw new Error('The exact connector generation is unavailable.');
      const timestamp = now().toISOString();
      const command: StoredWorkspaceCommand = {
        auditId: deterministicTaskExecutionId('workspace-command-audit', actor.userId, request.operationId),
        allowNetwork: handoff.requestedPermissions.network === 'open',
        commandId, commandSha256: sha(request.command), connectorGeneration: generation,
        connectorId: execution.connectorBinding.connectorId, createdAt: timestamp,
        environmentId: execution.environmentId, executionId: execution.id,
        expectedHeadSha: execution.source.commit,
        maxOutputBytes: limits.maxOutputBytes, outputCursor: 0, ownerUserId: actor.userId,
        projectId: `github:${execution.source.repositoryId}`, scope: 'workspace', state: 'queued',
        repositoryWritable: handoff.requestedPermissions.repository === 'write',
        startOperationFingerprint: fingerprint, startOperationId: request.operationId,
        stderr: '', stdout: '', targetReference: workspace.target.reference,
        timeoutSeconds: limits.timeoutSeconds, truncated: false, updatedAt: timestamp,
        workspaceId: workspace.id,
        workspaceWritable: handoff.requestedPermissions.workspace === 'write'
      };
      const created = await dependencies.commands.create(command);
      if (created === 'conflict') throw new Error('Workspace command identity conflicts.');
      const claimed = await dependencies.operations.claimDispatch({
        action: 'start_workspace_command', executionId: request.executionId, fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId
      });
      if (claimed === 'conflict') throw new Error('Workspace command dispatch conflicts.');
      if (claimed === 'in_progress') {
        return await replayOrReconcile(
          actor, commandId, 'start_workspace_command', fingerprint, request.operationId
        ) ?? project(command);
      }
      const started = await invoke(command, 'start', request.command);
      await finishOperation(started, 'start_workspace_command', fingerprint, request.operationId);
      return project(started);
    },

    async startRecovery(actor, request, approve) {
      if (!dependencies.recovery) throw new Error('Provider recovery is unavailable.');
      const limits = normalizeLimits(request);
      const fingerprint = taskExecutionFingerprint({ action: 'start_environment_recovery_command', ...request, ...limits });
      const commandId = deterministicTaskExecutionId('recovery-command', actor.userId, request.operationId);
      if (!await dependencies.commands.read(actor.userId, commandId) && !await approve()) {
        throw new Error('The user did not approve the recovery command.');
      }
      const reservation = await dependencies.operations.reserve({
        action: 'start_environment_recovery_command', fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId
      });
      if (reservation.kind === 'conflict') throw new Error('Operation ID belongs to another command.');
      if (reservation.kind !== 'new') {
        const replay = await replayOrReconcile(
          actor, commandId, 'start_environment_recovery_command', fingerprint,
          request.operationId, request.command
        );
        if (replay) return replay;
      }
      const resolved = await dependencies.recovery.resolve({
        environmentId: request.environmentId, operationId: request.operationId, userId: actor.userId
      });
      if (resolved.state !== 'ready') throw new Error('Codespace recovery is unavailable.');
      const timestamp = now().toISOString();
      const command: StoredWorkspaceCommand = {
        auditId: deterministicTaskExecutionId('recovery-command-audit', actor.userId, request.operationId),
        commandId, commandSha256: sha(request.command), createdAt: timestamp,
        environmentId: request.environmentId, maxOutputBytes: limits.maxOutputBytes,
        outputCursor: 0, ownerUserId: actor.userId, providerKind: 'github_codespaces',
        providerResourceId: resolved.providerResourceId, scope: 'environment_recovery',
        startOperationFingerprint: fingerprint, startOperationId: request.operationId,
        state: 'queued', stderr: '', stdout: '', timeoutSeconds: limits.timeoutSeconds,
        truncated: false, updatedAt: timestamp
      };
      const created = await dependencies.commands.create(command);
      if (created === 'conflict') throw new Error('Recovery command identity conflicts.');
      const claimed = await dependencies.operations.claimDispatch({
        action: 'start_environment_recovery_command', fingerprint,
        operationId: request.operationId, ownerUserId: actor.userId
      });
      if (claimed !== 'claimed') return project(await invoke(command, 'status'));
      const started = await invoke(command, 'start', request.command);
      await finishOperation(started, 'start_environment_recovery_command', fingerprint, request.operationId);
      return project(started);
    },

    async get(actor, request) {
      const command = await dependencies.commands.read(actor.userId, request.commandId);
      if (!command) throw new Error('Workspace command was not found.');
      const refreshed = terminal(command.state) ? command : await invoke(command, 'status');
      if (terminal(refreshed.state)) await finishStartOperation(refreshed);
      return project(refreshed, request.afterCursor);
    },

    cancelRecovery: (actor, request) => cancelCommand(actor, request, 'environment_recovery'),
    cancelWorkspace: (actor, request) => cancelCommand(actor, request, 'workspace')
  };
}

function connectorRequest(
  command: Extract<StoredWorkspaceCommand, { scope: 'workspace' }>,
  operation: WorkspaceCommandConnectorOperation,
  rawCommand?: string
): WorkspaceCommandConnectorRequest {
  return {
    allowNetwork: command.allowNetwork, ...(operation === 'start' ? { command: rawCommand } : {}),
    commandId: command.commandId, commandSha256: command.commandSha256,
    environmentId: command.environmentId, executionId: command.executionId,
    expectedHeadSha: command.expectedHeadSha,
    machineId: command.connectorId, maxOutputBytes: command.maxOutputBytes, operation,
    projectId: command.projectId, repositoryWritable: command.repositoryWritable,
    timeoutSeconds: command.timeoutSeconds,
    workspaceId: command.workspaceId, workspaceWritable: command.workspaceWritable,
    worktreeId: command.targetReference
  };
}

function project(command: StoredWorkspaceCommand, afterCursor = 0): WorkspaceCommandResult {
  const visible = command.outputCursor > afterCursor;
  return {
    apiVersion: 1, auditId: command.auditId, checkedAt: command.updatedAt,
    commandId: command.commandId, environmentId: command.environmentId,
    ...(command.executionId ? { executionId: command.executionId } : {}),
    ...(command.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    ...(command.finishedAt ? { finishedAt: command.finishedAt } : {}),
    message: message(command.state), nextCursor: command.outputCursor,
    output: visible ? [{ cursor: command.outputCursor,
      ...(command.stderr ? { stderr: command.stderr } : {}),
      ...(command.stdout ? { stdout: command.stdout } : {}) }] : [],
    scope: command.scope, ...(command.startedAt ? { startedAt: command.startedAt } : {}),
    state: command.state, target: { kind: command.scope === 'workspace'
      ? 'connector_workspace' : 'github_codespace_recovery' }, truncated: command.truncated
  };
}

function normalizeLimits(request: { maxOutputBytes?: number; timeoutSeconds?: number }) {
  return {
    maxOutputBytes: request.maxOutputBytes ?? 64 * 1024,
    timeoutSeconds: request.timeoutSeconds ?? 120
  };
}
function sha(value: string) { return createHash('sha256').update(value).digest('hex'); }
function terminal(state: StoredWorkspaceCommand['state']) {
  return ['cancelled', 'completed', 'failed', 'unsupported'].includes(state);
}
function message(state: StoredWorkspaceCommand['state']) {
  if (state === 'completed') return 'The workspace command completed.';
  if (state === 'failed') return 'The workspace command failed.';
  if (state === 'cancelled') return 'The workspace command was cancelled.';
  if (state === 'unsupported') return 'The target cannot safely execute this command.';
  if (state === 'uncertain') return 'The command outcome requires reconciliation.';
  return state === 'running' ? 'The workspace command is running.' : 'The workspace command is queued.';
}

function safeOutput(value: string, maximumBytes: number) {
  const redacted = value
    .replace(/(?:bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi, '[redacted]')
    .replace(/(?:\/(?:Users|home|root|private|opt\/platform)\/[^\s:'"`]+|[A-Za-z]:\\Users\\[^\s:'"`]+)/g, '[path]')
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  const bytes = Buffer.from(redacted, 'utf8');
  return bytes.subarray(0, Math.max(0, maximumBytes)).toString('utf8');
}
