import type {
  CodexSessionsClient,
  CodexSessionSettingsRequest,
  CodexSessionTurnSettings
} from '../../shared/codex-sessions-api';
import type { MachineRuntimeStatusResult } from '../../shared/project-space-api';
import { codexContinueBlockReason, codexSteerBlockReason } from './codex-sessions-model';
import type {
  CodexApprovalDecision,
  CodexThreadOrigin,
  CodexUserInputDecision
} from './codex-sessions-types';
import {
  applyCodexReadResult,
  applyCodexStreamEvent,
  initialCodexSessionsControllerState,
  sameCodexOrigin,
  toCodexMachine,
  toCodexSession,
  upsertCodexMachine,
  upsertCodexSession,
  type CodexSessionsControllerState
} from './codex-sessions-controller-state';

const defaultRuntimeLoadTimeoutMs = 3_000;

export {
  applyCodexReadResult,
  applyCodexStreamEvent,
  initialCodexSessionsControllerState,
  toCodexConversationItem
} from './codex-sessions-controller-state';
export type { CodexSessionsControllerState } from './codex-sessions-controller-state';

export class CodexSessionsControllerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CodexSessionsControllerError';
  }
}
export class CodexSessionsController {
  private state = initialCodexSessionsControllerState();
  private listeners = new Set<() => void>();
  private machineLoadVersions = new Map<string, number>();
  private stopStream?: () => void;
  private selectionVersion = 0;
  private retryOperations = new Map<string, string>();
  constructor(
    private readonly client: CodexSessionsClient,
    private readonly createOperationId = defaultOperationId,
    private readonly loadMachineRuntime?: (
      machineId: string,
      signal?: AbortSignal
    ) => Promise<MachineRuntimeStatusResult>,
    private readonly runtimeLoadTimeoutMs = defaultRuntimeLoadTimeoutMs
  ) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async loadMachines(
    machineIds: string[],
    connectorInstanceIds: Readonly<Record<string, string | undefined>> = {}
  ) {
    const uniqueMachineIds = [...new Set(machineIds)];
    this.update({
      ...this.state,
      loadingMachineIds: uniqueMachineIds
    });
    await Promise.all(uniqueMachineIds.map(async (machineId) => {
      const loadVersion = (this.machineLoadVersions.get(machineId) ?? 0) + 1;
      this.machineLoadVersions.set(machineId, loadVersion);
      const isCurrentLoad = () => this.machineLoadVersions.get(machineId) === loadVersion;
      let inventoryConnectorInstanceId = connectorInstanceIds[machineId];
      const loadMachineRuntime = this.loadMachineRuntime;
      if (loadMachineRuntime) {
        try {
          const runtime = await withDeadline(
            (signal) => loadMachineRuntime(machineId, signal),
            this.runtimeLoadTimeoutMs
          );
          if (!isCurrentLoad()) return;
          inventoryConnectorInstanceId = runtime.runtime?.instanceId ?? inventoryConnectorInstanceId;
          this.update({
            ...this.state,
            runtimeByMachineId: {
              ...this.state.runtimeByMachineId,
              [machineId]: runtime
            }
          });
        } catch {
          if (!isCurrentLoad()) return;
          const runtimeByMachineId = { ...this.state.runtimeByMachineId };
          delete runtimeByMachineId[machineId];
          this.update({ ...this.state, runtimeByMachineId });
          // The verified inventory can still establish Codex readiness without maintenance status.
        }
      }
      try {
        const result = await this.client.list({ includeArchived: true, machineId });
        if (!isCurrentLoad()) return;
        const selected = this.state.selectedOrigin?.machineId === machineId
          ? this.state.sessions.find((session) => sameCodexOrigin(session, this.state.selectedOrigin!))
          : undefined;
        const nextSessions = result.sessions.map(toCodexSession);
        if (selected && !nextSessions.some((session) => sameCodexOrigin(session, selected))) {
          nextSessions.push({ ...selected, status: 'missing' });
        }
        this.update({
          ...this.state,
          loadingMachineIds: this.state.loadingMachineIds.filter((id) => id !== machineId),
          machines: upsertCodexMachine(
            this.state.machines,
            toCodexMachine(result, inventoryConnectorInstanceId)
          ),
          sessions: [
            ...this.state.sessions.filter((session) => session.machineId !== machineId),
            ...nextSessions
          ]
        });
      } catch (error) {
        if (!isCurrentLoad()) return;
        const offline = isOfflineError(error);
        this.update({
          ...this.state,
          loadingMachineIds: this.state.loadingMachineIds.filter((id) => id !== machineId),
          machines: upsertCodexMachine(this.state.machines, {
            id: machineId,
            name: this.state.machines.find((machine) => machine.id === machineId)?.name ?? machineId,
            status: offline ? 'offline' : 'unavailable',
            statusDetail: errorMessage(error),
            inventoryConnectorInstanceId
          })
        });
      }
    }));
  }

  async select(origin: CodexThreadOrigin) {
    const version = ++this.selectionVersion;
    this.stopStream?.();
    this.stopStream = undefined;
    const placeholder = this.state.sessions.find((session) => sameCodexOrigin(session, origin)) ?? {
      lastActivityAt: new Date().toISOString(),
      loadedByProjectSpace: false,
      machineId: origin.machineId,
      status: 'missing' as const,
      stored: false,
      threadId: origin.threadId,
      title: 'Unavailable Codex thread'
    };
    this.update({
      ...this.state,
      activeTurnId: undefined,
      approvalBindings: {},
      errorMessage: undefined,
      inputBindings: {},
      reading: true,
      selectedOrigin: origin,
      sessions: upsertCodexSession(this.state.sessions, placeholder)
    });
    try {
      const result = await this.client.read(origin);
      if (version !== this.selectionVersion) return;
      this.update(applyCodexReadResult(this.state, result));
      if (result.session.status === 'active' || result.session.status === 'idle') {
        this.stopStream = this.client.subscribe(
          { ...origin, afterSequence: result.streamCursor },
          (event) => {
            if (version === this.selectionVersion) this.update(applyCodexStreamEvent(this.state, event));
          },
          (error) => {
            if (version === this.selectionVersion) this.update({ ...this.state, errorMessage: errorMessage(error) });
          }
        );
      }
    } catch (error) {
      if (version !== this.selectionVersion) return;
      const status = isMissingError(error) ? 'missing' : isOfflineError(error) ? 'offline' : 'unavailable';
      this.update({
        ...this.state,
        errorMessage: errorMessage(error),
        reading: false,
        sessions: this.state.sessions.map((session) => sameCodexOrigin(session, origin)
          ? { ...session, status, statusDetail: errorMessage(error) }
          : session)
      });
    }
  }

  clearSelection() {
    this.selectionVersion += 1;
    this.stopStream?.();
    this.stopStream = undefined;
    this.update({
      ...this.state,
      activeTurnId: undefined,
      approvalBindings: {},
      inputBindings: {},
      reading: false,
      selectedOrigin: undefined
    });
  }

  async continue(
    origin: CodexThreadOrigin,
    message: string,
    settings?: CodexSessionTurnSettings,
    imageAttachmentIds: readonly string[] = []
  ) {
    const session = this.requireSelectedSession(origin);
    const machine = this.state.machines.find((entry) => entry.id === origin.machineId);
    const blocked = codexContinueBlockReason(session, machine);
    if (blocked) throw new CodexSessionsControllerError('thread_not_idle', blocked);
    const cleanMessage = message.trim();
    if (!cleanMessage) throw new CodexSessionsControllerError('empty_message', 'Enter a message first.');
    const selectedModel = settings?.model.trim();
    const selectedEffort = settings?.effort?.trim();
    const selectedServiceTier = settings?.serviceTier === null
      ? null
      : settings?.serviceTier?.trim();
    const selectedSettings = selectedModel ? {
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      model: selectedModel,
      ...(selectedServiceTier !== undefined ? { serviceTier: selectedServiceTier } : {})
    } : undefined;
    const key = `continue:${JSON.stringify([
      origin.machineId,
      origin.threadId,
      selectedSettings ?? null,
      imageAttachmentIds,
      cleanMessage
    ])}`;
    const result = await this.runOperation(key, (operationId) => this.client.continue({
      ...origin,
      ...(imageAttachmentIds.length ? { imageAttachmentIds: [...imageAttachmentIds] } : {}),
      message: cleanMessage,
      ...selectedSettings,
      operationId
    }));
    if (result.status === 'accepted' || result.status === 'completed') {
      this.update({
        ...this.state,
        activeTurnId: result.turnId ?? this.state.activeTurnId,
        sessions: this.state.sessions.map((entry) => sameCodexOrigin(entry, origin)
          ? { ...entry, status: 'active' }
          : entry)
      });
    }
    return result;
  }

  async steer(
    origin: CodexThreadOrigin,
    message: string,
    imageAttachmentIds: readonly string[] = []
  ) {
    const session = this.requireSelectedSession(origin);
    const machine = this.state.machines.find((entry) => entry.id === origin.machineId);
    const blocked = codexSteerBlockReason(session, machine);
    if (blocked) {
      throw new CodexSessionsControllerError(
        'thread_not_active',
        blocked
      );
    }
    const expectedTurnId = this.state.activeTurnId;
    if (!expectedTurnId) {
      throw new CodexSessionsControllerError(
        'missing_turn',
        'The active Codex turn is no longer available.'
      );
    }
    const cleanMessage = message.trim();
    if (!cleanMessage) throw new CodexSessionsControllerError('empty_message', 'Enter a message first.');
    const key = `steer:${JSON.stringify([
      origin.machineId,
      origin.threadId,
      expectedTurnId,
      imageAttachmentIds,
      cleanMessage
    ])}`;
    return this.runOperation(key, (operationId) => this.client.continue({
      delivery: 'steer',
      expectedTurnId,
      ...(imageAttachmentIds.length ? { imageAttachmentIds: [...imageAttachmentIds] } : {}),
      ...origin,
      message: cleanMessage,
      operationId
    }));
  }

  browser(origin: CodexThreadOrigin) {
    return this.client.browser(origin);
  }

  interrupt(origin: CodexThreadOrigin, turnId: string) {
    const key = `interrupt:${origin.machineId}:${origin.threadId}:${turnId}`;
    return this.runOperation(key, (operationId) => this.client.interrupt({
      ...origin, operationId, turnId
    }));
  }

  async updatePermissionProfile(
    origin: CodexThreadOrigin,
    permissionProfileId: string
  ) {
    this.requireSelectedSession(origin);
    const profileId = permissionProfileId.trim();
    if (!profileId) {
      throw new CodexSessionsControllerError(
        'invalid_permission_profile',
        'Choose a permission profile first.'
      );
    }
    const key = `settings:${origin.machineId}:${origin.threadId}:${profileId}`;
    const result = await this.runOperation(key, (operationId) => this.client.settings({
      ...origin,
      operationId,
      permissionProfileId: profileId
    } satisfies CodexSessionSettingsRequest));
    if (result.status === 'accepted' || result.status === 'completed') {
      this.update({
        ...this.state,
        sessions: this.state.sessions.map((session) => sameCodexOrigin(session, origin)
          ? { ...session, permissionProfileId: profileId }
          : session)
      });
    }
    return result;
  }

  async resolveApproval(decision: CodexApprovalDecision) {
    this.requireSelectedSession(decision);
    const binding = this.state.approvalBindings[decision.requestId];
    if (!binding?.turnId) throw new CodexSessionsControllerError('missing_turn', 'The active turn is no longer available.');
    if (decision.decision === 'allow_once' && !binding.canAllow) {
      throw new CodexSessionsControllerError(
        'permission_details_unavailable',
        'Project Space cannot safely display the complete permission request.'
      );
    }
    const key = `approval:${decision.machineId}:${decision.threadId}:${decision.requestId}:${decision.decision}`;
    const result = await this.runOperation(key, (operationId) => this.client.approve({
      approvalId: binding.approvalId,
      decision: decision.decision === 'allow_once' ? 'allow-once' : 'deny',
      itemId: binding.itemId,
      machineId: decision.machineId,
      operationId,
      requestId: decision.requestId,
      threadId: decision.threadId,
      turnId: binding.turnId
    }));
    if (result.status === 'accepted' || result.status === 'completed') {
      this.removePrompt(decision.requestId, 'approval');
    }
    return result;
  }

  async resolveUserInput(decision: CodexUserInputDecision) {
    this.requireSelectedSession(decision);
    const binding = this.state.inputBindings[decision.requestId];
    if (!binding?.turnId) throw new CodexSessionsControllerError('missing_turn', 'The active turn is no longer available.');
    const key = `input:${decision.machineId}:${decision.threadId}:${decision.requestId}:${JSON.stringify(decision.answers)}`;
    const result = await this.runOperation(key, (operationId) => this.client.respondToUserInput({
      answers: decision.answers,
      machineId: decision.machineId,
      operationId,
      requestId: decision.requestId,
      threadId: decision.threadId,
      turnId: binding.turnId
    }));
    if (result.status === 'accepted' || result.status === 'completed') {
      this.removePrompt(decision.requestId, 'input');
    }
    return result;
  }

  dispose() {
    this.selectionVersion += 1;
    this.stopStream?.();
    this.stopStream = undefined;
    this.listeners.clear();
  }

  private requireSelectedSession(origin: CodexThreadOrigin) {
    const selected = this.state.selectedOrigin;
    const session = this.state.sessions.find((entry) => sameCodexOrigin(entry, origin));
    if (!session || !selected || selected.machineId !== origin.machineId || selected.threadId !== origin.threadId) {
      throw new CodexSessionsControllerError('origin_mismatch', 'Select this machine and thread before continuing it.');
    }
    return session;
  }

  private async runOperation<T extends { status: string }>(key: string, run: (operationId: string) => Promise<T>) {
    const operationId = this.retryOperations.get(key) ?? this.createOperationId(key.split(':')[0]);
    this.retryOperations.set(key, operationId);
    this.update({ ...this.state, errorMessage: undefined });
    try {
      const result = await run(operationId);
      if (result.status !== 'ambiguous') this.retryOperations.delete(key);
      if (result.status === 'rejected') {
        this.update({ ...this.state, errorMessage: 'Codex rejected the requested operation.' });
      }
      return result;
    } catch (error) {
      if (isDefinitiveError(error)) this.retryOperations.delete(key);
      this.update({ ...this.state, errorMessage: errorMessage(error) });
      throw error;
    }
  }

  private removePrompt(requestId: string, kind: 'approval' | 'input') {
    const origin = this.state.selectedOrigin;
    if (!origin) return;
    const conversations = this.state.conversations.map((conversation) => !sameCodexOrigin(conversation, origin)
      ? conversation
      : kind === 'approval'
        ? { ...conversation, approvals: conversation.approvals?.filter((entry) => entry.id !== requestId) }
        : { ...conversation, userInputRequests: conversation.userInputRequests?.filter((entry) => entry.id !== requestId) });
    if (kind === 'approval') {
      const approvalBindings = { ...this.state.approvalBindings };
      delete approvalBindings[requestId];
      this.update({ ...this.state, approvalBindings, conversations });
      return;
    }
    const inputBindings = { ...this.state.inputBindings };
    delete inputBindings[requestId];
    this.update({ ...this.state, conversations, inputBindings });
  }

  private update(state: CodexSessionsControllerState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Codex sessions are unavailable.';
}
function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code).toLowerCase()
    : '';
}
function errorStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : undefined;
}
function isOfflineError(error: unknown) {
  return errorStatus(error) === 503 || /offline|connector_unavailable/.test(errorCode(error));
}
function isMissingError(error: unknown) {
  return errorStatus(error) === 404 || /missing|not_found/.test(errorCode(error));
}
function isDefinitiveError(error: unknown) {
  const status = errorStatus(error);
  return status !== undefined && status >= 400 && status < 500;
}
function defaultOperationId(action: string) {
  return `codex-ui:${action}:${crypto.randomUUID()}`;
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Connector runtime status timed out.');
          reject(error);
          controller.abort(error);
        }, Math.max(1, timeoutMs));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
