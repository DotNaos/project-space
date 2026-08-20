import { createHash } from 'node:crypto';

import type {
  CodexSessionReadRequest,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import {
  workspaceRuntimeCodexCapability,
  type WorkspaceRuntimeCodexCommand,
  type WorkspaceRuntimeCodexMessage,
  type WorkspaceRuntimeCodexResult
} from '../../src/shared/workspace-runtime-codex-api';
import {
  CodexSessionManager,
  CodexSessionsExecutor,
  type CodexSessionsBoundOperation
} from '../codex-sessions';
import { createCodexOperationSnapshotPersistence } from '../codex-sessions/operation-snapshot-store';
import { CodexHostJournal, codexHostFingerprint } from './journal';
import {
  CodexHostCommandError,
  generationNumber,
  parseCodexHostCommand,
  type CodexHostScope
} from './validation';

export interface WorkspaceRuntimeCodexHostOptions {
  binaryPath: string;
  codexHome: string;
  environmentId: string;
  generation: string;
  journalPath: string;
  operationSnapshotPath: string;
  ownerUserId: string;
  workspaceId: string;
  createManager?: (options: ConstructorParameters<typeof CodexSessionManager>[0]) => CodexSessionManager;
  emit(message: WorkspaceRuntimeCodexMessage): void;
  stopTimeoutMs?: number;
}

export interface WorkspaceRuntimeCodexHostReady {
  acceptedCommandSequence: number;
  capability: typeof workspaceRuntimeCodexCapability;
  lastEventSequence: number;
  state: 'ready';
}

export class WorkspaceRuntimeCodexHostController {
  private readonly executor: CodexSessionsExecutor;
  private readonly journal: CodexHostJournal;
  private readonly manager: CodexSessionManager;
  private readonly machineId: string;
  private sessionId = '';
  private state: 'starting' | 'ready' | 'stopping' | 'stopped' = 'starting';
  private stopPromise?: Promise<void>;
  private readonly streams = new Map<string, () => void>();

  constructor(private readonly options: WorkspaceRuntimeCodexHostOptions) {
    this.machineId = runtimeMachineId(options);
    const identity = [
      options.ownerUserId, options.workspaceId, options.environmentId, options.generation,
      this.machineId
    ].join('\0');
    const bindingDigest = createHash('sha256').update(identity).digest('hex');
    this.journal = new CodexHostJournal(options.journalPath, bindingDigest);
    const operations = createCodexOperationSnapshotPersistence({
      PROJECT_CODEX_OPERATION_SNAPSHOT_FILE: options.operationSnapshotPath
    }, this.machineId);
    const managerOptions = {
      binaryPath: options.binaryPath,
      codexHome: options.codexHome,
      operationSnapshot: operations.snapshot,
      persistOperationSnapshot: operations.persist
    };
    this.manager = options.createManager?.(managerOptions) ?? new CodexSessionManager(managerOptions);
    this.executor = new CodexSessionsExecutor({
      expectedGeneration: generationNumber(options.generation),
      expectedMachineId: this.machineId,
      machineName: `Workspace ${options.workspaceId}`,
      manager: this.manager
    });
  }

  async start(): Promise<WorkspaceRuntimeCodexHostReady> {
    if (this.state !== 'starting') throw new Error('The Codex host was already started.');
    await this.manager.listLoadedThreads();
    this.state = 'ready';
    const snapshot = this.journal.snapshot();
    return {
      acceptedCommandSequence: snapshot.acceptedCommandSequence,
      capability: workspaceRuntimeCodexCapability,
      lastEventSequence: snapshot.lastEventSequence,
      state: 'ready'
    };
  }

  bind(sessionId: string, resumeAfterEventSequence: number) {
    if (this.state !== 'ready' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(sessionId) ||
        !Number.isSafeInteger(resumeAfterEventSequence) || resumeAfterEventSequence < 0) {
      throw new Error('The Codex host socket binding is invalid.');
    }
    this.sessionId = sessionId;
    for (const event of this.journal.eventsAfter(resumeAfterEventSequence)) {
      this.emit({ ...event, sessionId });
    }
  }

  async command(value: unknown) {
    if (this.state !== 'ready') return this.emitError(value, 'runtime_stopping');
    const scope: CodexHostScope = {
      actorOwnerUserId: this.options.ownerUserId,
      environmentId: this.options.environmentId,
      generation: this.options.generation,
      machineId: this.machineId,
      sessionId: this.sessionId,
      workspaceId: this.options.workspaceId
    };
    let command: WorkspaceRuntimeCodexCommand;
    try {
      command = parseCodexHostCommand(value, scope);
    } catch (error) {
      return this.emitError(value, error instanceof CodexHostCommandError &&
        error.code === 'stale_generation' ? 'unavailable' : 'invalid_command');
    }
    const comparable = { ...command, sessionId: '' };
    const fingerprint = codexHostFingerprint(comparable);
    const snapshot = this.journal.snapshot();
    if (command.commandSequence <= snapshot.acceptedCommandSequence) {
      const prior = this.journal.command(command.commandSequence);
      if (!prior || prior.fingerprint !== fingerprint) return this.emitError(command, 'invalid_command');
      if (prior.state !== 'completed') return this.emitError(command, 'uncertain');
      for (const message of prior.messages) {
        const replay = message.type === 'runtime.codex.command-accepted'
          ? { ...message, replayed: true, sessionId: this.sessionId }
          : { ...message, sessionId: this.sessionId };
        this.emit(replay as WorkspaceRuntimeCodexMessage);
      }
      return;
    }
    if (command.commandSequence !== snapshot.acceptedCommandSequence + 1) {
      return this.emitError(command, 'invalid_command');
    }
    await this.journal.beginCommand(command.commandSequence, fingerprint);
    const accepted = this.message(command, {
      acceptedCommandSequence: command.commandSequence,
      replayed: false,
      type: 'runtime.codex.command-accepted'
    });
    this.emit(accepted);
    try {
      const result = await this.execute(command);
      const completed = this.message(command, { result, type: 'runtime.codex.result' });
      await this.journal.completeCommand(command.commandSequence, [accepted, completed]);
      this.emit(completed);
    } catch {
      const failed = this.message(command, {
        code: 'unavailable',
        message: 'The Codex App Server operation is unavailable.',
        type: 'runtime.codex.error'
      });
      await this.journal.completeCommand(command.commandSequence, [accepted, failed]);
      this.emit(failed);
    }
  }

  async stop() {
    if (this.state === 'stopped') return;
    if (this.stopPromise) return this.stopPromise;
    this.state = 'stopping';
    this.stopPromise = this.stopBounded();
    return this.stopPromise;
  }

  private async stopBounded() {
    try {
      for (const unsubscribe of this.streams.values()) unsubscribe();
      this.streams.clear();
      this.executor.close();
      await settleWithin(this.manager.close(), this.options.stopTimeoutMs ?? 4_000);
    } finally {
      this.state = 'stopped';
    }
  }

  private async execute(command: WorkspaceRuntimeCodexCommand): Promise<WorkspaceRuntimeCodexResult> {
    if (command.kind === 'runtime-start') return { state: 'ready' };
    if (command.kind === 'runtime-stop') {
      queueMicrotask(() => void this.stop());
      return { state: 'stopped' };
    }
    if (command.kind === 'stream-start') {
      this.streams.get(command.request.threadId)?.();
      const unsubscribe = this.executor.streamBound(command.request, (event) => {
        void this.emitEvent(command, event).catch(() => undefined);
      });
      this.streams.set(command.request.threadId, unsubscribe);
      return { state: 'streaming' };
    }
    if (command.kind === 'stream-stop') {
      this.streams.get(command.request.threadId)?.();
      this.streams.delete(command.request.threadId);
      return { state: 'stopped' };
    }
    const operation = command.kind as CodexSessionsBoundOperation;
    const request = command.kind === 'start' && command.request.cwd === '.'
      ? { ...command.request, cwd: process.cwd() }
      : command.request;
    const wireResult = await this.executor.executeBound(
      operation,
      request,
      generationNumber(this.options.generation)
    );
    return wireResult.result as WorkspaceRuntimeCodexResult;
  }

  private async emitEvent(command: WorkspaceRuntimeCodexCommand, event: CodexSessionStreamEvent) {
    const eventSequence = this.journal.snapshot().lastEventSequence + 1;
    const message = this.message(command, {
      event,
      eventSequence,
      type: 'runtime.codex.event'
    });
    await this.journal.appendEvent(message as Extract<
      WorkspaceRuntimeCodexMessage,
      { type: 'runtime.codex.event' }
    >);
    this.emit(message);
  }

  private emitError(
    value: unknown,
    code: Extract<WorkspaceRuntimeCodexMessage, { type: 'runtime.codex.error' }>['code']
  ) {
    const binding = errorBinding(value);
    if (!binding) return;
    this.emit({
      ...binding,
      code,
      message: 'The Workspace Runtime Codex command was rejected.',
      type: 'runtime.codex.error'
    });
  }

  private emit(message: WorkspaceRuntimeCodexMessage) {
    if (Buffer.byteLength(JSON.stringify(message)) > 48 * 1024) {
      throw new Error('The Workspace Runtime Codex message is too large.');
    }
    this.options.emit(message);
  }

  private message<T extends Omit<WorkspaceRuntimeCodexMessage, keyof WorkspaceRuntimeCodexCommand>>(
    command: WorkspaceRuntimeCodexCommand,
    value: T
  ) {
    const { kind: _kind, request: _request, type: _type, ...binding } = command;
    return { ...binding, ...value } as WorkspaceRuntimeCodexMessage & T;
  }
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
  ]);
  if (timer) clearTimeout(timer);
}

function runtimeMachineId(options: WorkspaceRuntimeCodexHostOptions) {
  const digest = createHash('sha256').update([
    options.workspaceId, options.environmentId, options.generation
  ].join('\0')).digest('hex').slice(0, 32);
  return `workspace-runtime:${digest}`;
}

function errorBinding(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const actorKind = input.actorKind;
  if (!['agent', 'human', 'orchestrator', 'system'].includes(String(actorKind))) return undefined;
  const strings = [
    'actorId', 'actorUserId', 'commandId', 'environmentId', 'generation',
    'operationId', 'sessionId', 'workspaceId'
  ] as const;
  if (strings.some((key) => typeof input[key] !== 'string' || !input[key])) return undefined;
  if (!Number.isSafeInteger(input.commandSequence) || input.schemaVersion !== 1) return undefined;
  return {
    actorId: String(input.actorId),
    actorKind: actorKind as WorkspaceRuntimeCodexCommand['actorKind'],
    actorUserId: String(input.actorUserId),
    commandId: String(input.commandId),
    commandSequence: Number(input.commandSequence),
    environmentId: String(input.environmentId),
    generation: String(input.generation),
    operationId: String(input.operationId),
    schemaVersion: 1 as const,
    sessionId: String(input.sessionId),
    ...(typeof input.targetThreadId === 'string' ? { targetThreadId: input.targetThreadId } : {}),
    workspaceId: String(input.workspaceId)
  };
}
