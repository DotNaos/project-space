import type {
  CodexConversationItemRecord,
  CodexSessionListResult,
  CodexSessionReadResult,
  CodexSessionStreamEvent
} from '../../shared/codex-sessions-api';
import type { MachineRuntimeStatusResult } from '../../shared/project-space-api';
import type {
  CodexConversation,
  CodexConversationItem,
  CodexMachine,
  CodexSession,
  CodexThreadOrigin
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
  runtimeByMachineId: Record<string, MachineRuntimeStatusResult>;
  seenEventIds: string[];
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
}

export function initialCodexSessionsControllerState(): CodexSessionsControllerState {
  return {
    approvalBindings: {},
    conversations: [],
    inputBindings: {},
    loadingMachineIds: [],
    machines: [],
    reading: false,
    runtimeByMachineId: {},
    seenEventIds: [],
    sessions: []
  };
}

export function toCodexMachine(
  result: CodexSessionListResult,
  inventoryConnectorInstanceId?: string
): CodexMachine {
  return {
    id: result.machine.id,
    inventoryCheckedAt: result.checkedAt,
    inventoryConnectorInstanceId,
    inventoryPublishedAt: result.publishedAt,
    inventoryState: result.inventoryState,
    name: result.machine.name,
    status: result.machine.online ? 'connected' : 'offline',
    statusDetail: result.machine.statusMessage,
    supportsModelSelection: result.machine.supportsModelSelection,
    supportsModelSettings: result.machine.supportsModelSettings
  };
}

export function toCodexSession(
  record: CodexSessionListResult['sessions'][number]
): CodexSession {
  return {
    attention: record.attention,
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

export function toCodexConversationItem(
  item: CodexConversationItemRecord
): CodexConversationItem {
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
    activityKind: item.kind,
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
  const session = toCodexSession(result.session);
  const conversation: CodexConversation = {
    items: result.turns.flatMap((turn) => turn.items.map(toCodexConversationItem)),
    machineId: session.machineId,
    threadId: session.threadId
  };
  const activeTurnId = [...result.turns].reverse().find(
    (turn) => turn.status === 'in-progress'
  )?.id;
  return {
    ...state,
    activeTurnId,
    approvalBindings: {},
    conversations: upsertCodexConversation(state.conversations, conversation),
    errorMessage: undefined,
    inputBindings: {},
    reading: false,
    seenEventIds: [],
    sessions: upsertCodexSession(state.sessions, session)
  };
}

export function applyCodexStreamEvent(
  state: CodexSessionsControllerState,
  event: CodexSessionStreamEvent
): CodexSessionsControllerState {
  if (state.seenEventIds.includes(event.eventId) || !state.selectedOrigin) return state;
  const seenEventIds = [...state.seenEventIds.slice(-499), event.eventId];
  const origin = state.selectedOrigin;
  let conversation = state.conversations.find((entry) => sameCodexOrigin(entry, origin)) ?? {
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
    sessions = sessions.map((session) => sameCodexOrigin(session, origin)
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
      sessions = sessions.map((session) => sameCodexOrigin(session, origin)
        ? { ...session, status: 'idle' }
        : session);
    }
  }

  return {
    ...state,
    activeTurnId,
    approvalBindings,
    conversations: upsertCodexConversation(state.conversations, conversation),
    inputBindings,
    seenEventIds,
    sessions
  };
}

export function upsertCodexMachine(machines: CodexMachine[], next: CodexMachine) {
  return [...machines.filter((machine) => machine.id !== next.id), next];
}

export function upsertCodexSession(sessions: CodexSession[], next: CodexSession) {
  return [...sessions.filter((session) => !sameCodexOrigin(session, next)), next];
}

export function upsertCodexConversation(
  conversations: CodexConversation[],
  next: CodexConversation
) {
  return [
    ...conversations.filter((conversation) => !sameCodexOrigin(conversation, next)),
    next
  ];
}

export function sameCodexOrigin(
  value: { machineId: string; threadId: string },
  origin: CodexThreadOrigin
) {
  return value.machineId === origin.machineId && value.threadId === origin.threadId;
}

function upsertItem(items: CodexConversationItem[], next: CodexConversationItem) {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  return items.map((item, itemIndex) => itemIndex === index ? next : item);
}

function upsertById<T extends { id: string }>(items: T[], next: T) {
  return [...items.filter((item) => item.id !== next.id), next];
}
