import type {
  CodexConversationItemRecord,
  CodexSessionListResult,
  CodexSessionReadResult,
  CodexSessionsClient,
  CodexSessionStreamEvent
} from '../../shared/codex-sessions-api';
import { codexContinueBlockReason } from './codex-sessions-model';
import type {
  CodexApprovalDecision,
  CodexConversation,
  CodexConversationItem,
  CodexMachine,
  CodexSession,
  CodexThreadOrigin,
  CodexUserInputDecision
} from './codex-sessions-types';
interface ApprovalBinding {
  approvalId?: string;
  canAllow: boolean;
  itemId?: string;
  turnId: string;
}
interface InputBinding {
  turnId: string;
}
export interface CodexSessionsControllerState {
  activeTurnId?: string;
  approvalBindings: Record<string, ApprovalBinding>;
  conversations: CodexConversation[];
  errorMessage?: string;
  inputBindings: Record<string, InputBinding>;
  loadingMachineIds: string[];
  machines: CodexMachine[];
  reading: boolean;
  seenEventIds: string[];
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
}
export class CodexSessionsControllerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CodexSessionsControllerError';
  }
}
export function initialCodexSessionsControllerState(): CodexSessionsControllerState {
  return {
    approvalBindings: {},
    conversations: [],
    inputBindings: {},
    loadingMachineIds: [],
    machines: [],
    reading: false,
    seenEventIds: [],
    sessions: []
  };
}
function toMachine(result: CodexSessionListResult): CodexMachine {
  return {
    id: result.machine.id,
    name: result.machine.name,
    status: result.machine.online ? 'connected' : 'offline',
    statusDetail: result.machine.statusMessage
  };
}
function toSession(record: CodexSessionListResult['sessions'][number]): CodexSession {
  return {
    cwd: record.cwd,
    lastActivityAt: record.lastActivityAt,
    loadedByProjectSpace: record.loadedByProjectSpace,
    machineId: record.machineId,
    model: record.model,
    projectName: record.project,
    status: record.status,
    stored: true,
    threadId: record.id,
    title: record.title
  };
}
const activityLabels: Record<CodexConversationItemRecord['kind'], string> = {
  'agent-message': 'Codex response',
  command: 'Command',
  'file-change': 'File change',
  'mcp-tool': 'Tool call',
  plan: 'Plan update',
  reasoning: 'Reasoning',
  status: 'Status',
  'user-message': 'User message'
};
export function toCodexConversationItem(item: CodexConversationItemRecord): CodexConversationItem {
  if (item.kind === 'agent-message' || item.kind === 'user-message') {
    return {
      id: item.id,
      kind: 'message',
      role: item.kind === 'agent-message' ? 'assistant' : 'user',
      streaming: item.status === 'in-progress',
      text: item.text ?? ''
    };
  }
  const state = item.status === 'in-progress'
    ? 'running'
    : item.status === 'pending'
      ? 'waiting'
      : item.status === 'failed'
        ? 'failed'
        : 'completed';
  return {
    detail: item.detail ?? item.text,
    id: item.id,
    kind: 'activity',
    label: activityLabels[item.kind],
    state
  };
}
export function applyCodexReadResult(
  state: CodexSessionsControllerState,
  result: CodexSessionReadResult
): CodexSessionsControllerState {
  const session = toSession(result.session);
  const conversation: CodexConversation = {
    items: result.turns.flatMap((turn) => turn.items.map(toCodexConversationItem)),
    machineId: session.machineId,
    threadId: session.threadId
  };
  const activeTurnId = [...result.turns].reverse().find((turn) => turn.status === 'in-progress')?.id;
  return {
    ...state,
    activeTurnId,
    approvalBindings: {},
    conversations: upsertConversation(state.conversations, conversation),
    errorMessage: undefined,
    inputBindings: {},
    reading: false,
    seenEventIds: [],
    sessions: upsertSession(state.sessions, session)
  };
}
export function applyCodexStreamEvent(
  state: CodexSessionsControllerState,
  event: CodexSessionStreamEvent
): CodexSessionsControllerState {
  if (state.seenEventIds.includes(event.eventId) || !state.selectedOrigin) return state;
  const seenEventIds = [...state.seenEventIds.slice(-499), event.eventId];
  const origin = state.selectedOrigin;
  let conversation = state.conversations.find((entry) => sameOrigin(entry, origin)) ?? {
    items: [], machineId: origin.machineId, threadId: origin.threadId
  };
  let activeTurnId = state.activeTurnId;
  let approvalBindings = state.approvalBindings;
  let inputBindings = state.inputBindings;
  let sessions = state.sessions;
  if (event.type === 'agent-message-delta') {
    const existing = conversation.items.find((item) => item.id === event.itemId);
    const next: CodexConversationItem = existing?.kind === 'message'
      ? { ...existing, streaming: true, text: `${existing.text}${event.delta}` }
      : { id: event.itemId, kind: 'message', role: 'assistant', streaming: true, text: event.delta };
    conversation = { ...conversation, items: upsertItem(conversation.items, next) };
  } else if (event.type === 'item') {
    const next = toCodexConversationItem(event.item);
    conversation = { ...conversation, items: upsertItem(conversation.items, next) };
  } else if (event.type === 'session-status') {
    sessions = sessions.map((session) => sameOrigin(session, origin)
      ? { ...session, status: event.status }
      : session);
  } else if (event.type === 'approval-requested') {
    activeTurnId = event.turnId;
    approvalBindings = {
      ...approvalBindings,
      [event.requestId]: {
        approvalId: event.approvalId,
        canAllow: event.canAllow !== false,
        itemId: event.itemId,
        turnId: event.turnId
      }
    };
    conversation = {
      ...conversation,
      approvals: upsertById(conversation.approvals ?? [], {
        canAllow: event.canAllow !== false,
        description: event.command ?? event.permissionSummary?.join('; ') ??
          'The requested permission details could not be displayed safely. You can deny this request.',
        id: event.requestId,
        title: event.kind === 'command'
          ? 'Run command'
          : event.kind === 'file-change'
            ? 'Change files'
            : 'Permission required'
      })
    };
  } else if (event.type === 'user-input-requested') {
    activeTurnId = event.turnId;
    inputBindings = { ...inputBindings, [event.requestId]: { turnId: event.turnId } };
    conversation = {
      ...conversation,
      userInputRequests: upsertById(conversation.userInputRequests ?? [], {
        id: event.requestId,
        questions: event.questions.map((question) => ({
          choices: (question.choices ?? []).map((choice) => ({
            description: choice.label === choice.value ? undefined : choice.label,
            value: choice.value
          })),
          id: question.id,
          prompt: question.prompt
        })),
        title: 'Codex needs input'
      })
    };
  } else if (event.type === 'turn-completed') {
    if (!activeTurnId || activeTurnId === event.turnId) {
      activeTurnId = undefined;
      approvalBindings = {};
      inputBindings = {};
      conversation = { ...conversation, approvals: [], userInputRequests: [] };
      sessions = sessions.map((session) => sameOrigin(session, origin)
        ? { ...session, status: 'idle' }
        : session);
    }
  }

  return {
    ...state,
    activeTurnId,
    approvalBindings,
    conversations: upsertConversation(state.conversations, conversation),
    inputBindings,
    seenEventIds,
    sessions
  };
}
export class CodexSessionsController {
  private state = initialCodexSessionsControllerState();
  private listeners = new Set<() => void>();
  private stopStream?: () => void;
  private selectionVersion = 0;
  private retryOperations = new Map<string, string>();
  constructor(
    private readonly client: CodexSessionsClient,
    private readonly createOperationId = defaultOperationId
  ) {}
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  async loadMachines(machineIds: string[]) {
    this.update({ ...this.state, loadingMachineIds: [...new Set(machineIds)] });
    await Promise.all(machineIds.map(async (machineId) => {
      try {
        const result = await this.client.list({ includeArchived: true, machineId });
        const selected = this.state.selectedOrigin?.machineId === machineId
          ? this.state.sessions.find((session) => sameOrigin(session, this.state.selectedOrigin!))
          : undefined;
        const nextSessions = result.sessions.map(toSession);
        if (selected && !nextSessions.some((session) => sameOrigin(session, selected))) {
          nextSessions.push({ ...selected, status: 'missing' });
        }
        this.update({
          ...this.state,
          loadingMachineIds: this.state.loadingMachineIds.filter((id) => id !== machineId),
          machines: upsertMachine(this.state.machines, toMachine(result)),
          sessions: [
            ...this.state.sessions.filter((session) => session.machineId !== machineId),
            ...nextSessions
          ]
        });
      } catch (error) {
        const offline = isOfflineError(error);
        this.update({
          ...this.state,
          errorMessage: errorMessage(error),
          loadingMachineIds: this.state.loadingMachineIds.filter((id) => id !== machineId),
          machines: upsertMachine(this.state.machines, {
            id: machineId,
            name: this.state.machines.find((machine) => machine.id === machineId)?.name ?? machineId,
            status: offline ? 'offline' : 'unavailable',
            statusDetail: errorMessage(error)
          })
        });
      }
    }));
  }

  async select(origin: CodexThreadOrigin) {
    const version = ++this.selectionVersion;
    this.stopStream?.();
    this.stopStream = undefined;
    const placeholder = this.state.sessions.find((session) => sameOrigin(session, origin)) ?? {
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
      sessions: upsertSession(this.state.sessions, placeholder)
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
        sessions: this.state.sessions.map((session) => sameOrigin(session, origin)
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

  async continue(origin: CodexThreadOrigin, message: string) {
    const session = this.requireSelectedSession(origin);
    const machine = this.state.machines.find((entry) => entry.id === origin.machineId);
    const blocked = codexContinueBlockReason(session, machine);
    if (blocked) throw new CodexSessionsControllerError('thread_not_idle', blocked);
    const cleanMessage = message.trim();
    if (!cleanMessage) throw new CodexSessionsControllerError('empty_message', 'Enter a message first.');
    const key = `continue:${origin.machineId}:${origin.threadId}:${cleanMessage}`;
    const result = await this.runOperation(key, (operationId) => this.client.continue({
      ...origin, message: cleanMessage, operationId
    }));
    if (result.status === 'accepted' || result.status === 'completed') {
      this.update({
        ...this.state,
        activeTurnId: result.turnId ?? this.state.activeTurnId,
        sessions: this.state.sessions.map((entry) => sameOrigin(entry, origin)
          ? { ...entry, status: 'active' }
          : entry)
      });
    }
    return result;
  }

  interrupt(origin: CodexThreadOrigin, turnId: string) {
    const key = `interrupt:${origin.machineId}:${origin.threadId}:${turnId}`;
    return this.runOperation(key, (operationId) => this.client.interrupt({
      ...origin, operationId, turnId
    }));
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
    const session = this.state.sessions.find((entry) => sameOrigin(entry, origin));
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
    const conversations = this.state.conversations.map((conversation) => !sameOrigin(conversation, origin)
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

function upsertMachine(machines: CodexMachine[], next: CodexMachine) {
  return [...machines.filter((machine) => machine.id !== next.id), next];
}
function upsertSession(sessions: CodexSession[], next: CodexSession) {
  return [...sessions.filter((session) => !sameOrigin(session, next)), next];
}
function upsertConversation(conversations: CodexConversation[], next: CodexConversation) {
  return [...conversations.filter((conversation) => !sameOrigin(conversation, next)), next];
}
function upsertItem(items: CodexConversationItem[], next: CodexConversationItem) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item, itemIndex) => itemIndex === index ? next : item);
}
function upsertById<T extends { id: string }>(items: T[], next: T) {
  return [...items.filter((item) => item.id !== next.id), next];
}
function sameOrigin(value: { machineId: string; threadId: string }, origin: CodexThreadOrigin) {
  return value.machineId === origin.machineId && value.threadId === origin.threadId;
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
