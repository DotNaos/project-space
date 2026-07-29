import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';

import type {
  CodexConversationItemRecord,
  CodexConversationTurnRecord,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import { CODEX_THREAD_ID_PATTERN } from '../../src/shared/codex-sessions-api';
import { scanProjectChatText } from '../project-chat/secret-scan';
import { resolveCodexRolloutPath } from './browser-snapshot-reader';
import { safeTranscriptActivity } from './transcript-activities';
import { transcriptMessageImages } from './transcript-images';

const READ_CHUNK_BYTES = 256 * 1024;
const MAXIMUM_LINE_BYTES = 12 * 1024 * 1024;
const MAXIMUM_VISIBLE_TURNS = 20;
const MAXIMUM_VISIBLE_TEXT = 32_000;
const POLL_INTERVAL_MS = 300;
const redactedText = '[Sensitive content redacted]';

interface TranscriptTurn extends CodexConversationTurnRecord {
  latestAssistantItemId?: string;
  pendingUserImages?: CodexConversationItemRecord['images'];
}

interface TranscriptState {
  currentTurn?: TranscriptTurn;
  device: number;
  identityRejected: boolean;
  identityVerified: boolean;
  inode: number;
  offset: number;
  path: string;
  pending: Buffer;
  recordedId?: string;
  skipLine: boolean;
  turns: TranscriptTurn[];
  userMessageTurns: Map<string, string>;
}

export interface LocalCodexTranscript {
  active: boolean;
  turns: CodexConversationTurnRecord[];
}

export interface LocalCodexTranscriptSource {
  read(threadId: string): Promise<LocalCodexTranscript>;
  watch(
    threadId: string,
    emit: (event: CodexSessionStreamEvent) => void,
    signal: AbortSignal
  ): Promise<void>;
}

export class LocalCodexTranscriptReader implements LocalCodexTranscriptSource {
  private readonly loads = new Map<string, Promise<RefreshResult>>();
  private readonly states = new Map<string, TranscriptState>();
  private readonly watchers = new Map<
    string,
    Set<(event: CodexSessionStreamEvent) => void>
  >();

  constructor(private readonly options: {
    codexHome?: string;
    sessionsRoot?: string;
  } = {}) {}

  async read(threadId: string): Promise<LocalCodexTranscript> {
    const result = await this.refresh(threadId);
    return this.snapshot(result.state, threadId);
  }

  async waitForUserMessage(
    threadId: string,
    clientId: string,
    timeoutMs = 5_000
  ) {
    const deadline = Date.now() + timeoutMs;
    do {
      const result = await this.refresh(threadId);
      const turnId = result.state.userMessageTurns.get(clientId);
      if (turnId) return turnId;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    return undefined;
  }

  async watch(
    threadId: string,
    emit: (event: CodexSessionStreamEvent) => void,
    signal: AbortSignal
  ) {
    const watchers = this.watchers.get(threadId) ?? new Set();
    watchers.add(emit);
    this.watchers.set(threadId, watchers);
    try {
      await this.refresh(threadId);
      while (!signal.aborted) {
        await abortableDelay(POLL_INTERVAL_MS, signal);
        if (signal.aborted) break;
        await this.refresh(threadId);
      }
    } finally {
      watchers.delete(emit);
      if (watchers.size === 0) this.watchers.delete(threadId);
    }
  }

  private async refresh(threadId: string) {
    if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
      throw new Error('The Codex task identity is invalid.');
    }
    const active = this.loads.get(threadId);
    if (active) return active;
    const load = this.load(threadId).then((result) => {
      this.publish(threadId, result.events);
      return result;
    });
    this.loads.set(threadId, load);
    try {
      return await load;
    } finally {
      if (this.loads.get(threadId) === load) this.loads.delete(threadId);
    }
  }

  private publish(threadId: string, events: readonly CodexSessionStreamEvent[]) {
    const watchers = this.watchers.get(threadId);
    if (!watchers?.size) return;
    for (const event of events) {
      for (const emit of watchers) emit(event);
    }
  }

  private async load(threadId: string): Promise<RefreshResult> {
    const resolved = await resolveCodexRolloutPath(threadId, this.options);
    if (!resolved) throw new Error('The Codex task history is unavailable.');
    const canonicalPath = await realpath(resolved.path);
    const file = await open(canonicalPath, 'r');
    try {
      const info = await file.stat();
      const previous = this.states.get(threadId);
      const state = previous &&
        previous.path === canonicalPath &&
        previous.device === info.dev &&
        previous.inode === info.ino &&
        previous.offset <= info.size
        ? previous
        : initialState(canonicalPath, info.dev, info.ino);
      const events: CodexSessionStreamEvent[] = [];
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (state.offset < info.size) {
        const length = Math.min(chunk.length, info.size - state.offset);
        const { bytesRead } = await file.read(chunk, 0, length, state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        processChunk(state, chunk.subarray(0, bytesRead), threadId, events);
      }
      this.states.set(threadId, state);
      return { events, state };
    } finally {
      await file.close();
    }
  }

  private snapshot(state: TranscriptState, expectedThreadId: string) {
    if (
      !state.identityVerified ||
      state.identityRejected ||
      state.recordedId !== expectedThreadId
    ) {
      throw new Error('The Codex task history identity could not be verified.');
    }
    return {
      active: state.currentTurn?.status === 'in-progress',
      turns: state.turns.map(({
        latestAssistantItemId: _latest,
        pendingUserImages: _pendingImages,
        ...turn
      }) => ({
        ...turn,
        items: turn.items.map((item) => ({
          ...item,
          ...(item.images ? { images: item.images.map((image) => ({ ...image })) } : {})
        }))
      }))
    };
  }
}

interface RefreshResult {
  events: CodexSessionStreamEvent[];
  state: TranscriptState;
}

function initialState(path: string, device: number, inode: number): TranscriptState {
  return {
    device,
    identityRejected: false,
    identityVerified: false,
    inode,
    offset: 0,
    path,
    pending: Buffer.alloc(0),
    skipLine: false,
    turns: [],
    userMessageTurns: new Map()
  };
}

function processChunk(
  state: TranscriptState,
  chunk: Buffer,
  threadId: string,
  events: CodexSessionStreamEvent[]
) {
  let input = state.pending.length > 0 ? Buffer.concat([state.pending, chunk]) : chunk;
  state.pending = Buffer.alloc(0);
  let start = 0;
  for (;;) {
    const newline = input.indexOf(10, start);
    if (newline < 0) break;
    const line = input.subarray(start, newline);
    start = newline + 1;
    if (state.skipLine) {
      state.skipLine = false;
      continue;
    }
    processLine(state, line, threadId, events);
  }
  const remainder = input.subarray(start);
  if (remainder.length > MAXIMUM_LINE_BYTES) {
    state.pending = Buffer.alloc(0);
    state.skipLine = true;
  } else {
    state.pending = Buffer.from(remainder);
  }
  input = Buffer.alloc(0);
}

function processLine(
  state: TranscriptState,
  line: Buffer,
  threadId: string,
  events: CodexSessionStreamEvent[]
) {
  if (line.length === 0 || line.length > MAXIMUM_LINE_BYTES) return;
  if (
    !line.includes('"session_meta"') &&
    !line.includes('"task_started"') &&
    !line.includes('"task_complete"') &&
    !line.includes('"user_message"') &&
    !line.includes('"agent_message"') &&
    !line.includes('"custom_tool_call"') &&
    !line.includes('"custom_tool_call_output"') &&
    !line.includes('"function_call"') &&
    !line.includes('"function_call_output"') &&
    !line.includes('"input_image"') &&
    !line.includes('"tool_search_call"') &&
    !line.includes('"tool_search_output"')
  ) return;
  let record: unknown;
  try {
    record = JSON.parse(line.toString('utf8'));
  } catch {
    return;
  }
  if (!isRecord(record) || !isRecord(record.payload)) return;
  const payload = record.payload;
  if (record.type === 'session_meta') {
    const id = payload.id ?? payload.session_id;
    if (typeof id === 'string' && CODEX_THREAD_ID_PATTERN.test(id)) {
      state.identityVerified = true;
      state.recordedId = id;
      if (id !== threadId) state.identityRejected = true;
    } else {
      state.identityRejected = true;
    }
    return;
  }
  const timestamp = isoTimestamp(record.timestamp);
  if (record.type === 'response_item') {
    processResponseItem(state, payload, threadId, events);
    return;
  }
  if (record.type !== 'event_msg') return;
  if (payload.type === 'task_started') {
    const turnId = identifier(payload.turn_id);
    if (!turnId) return;
    finishCurrentTurn(state, events, 'interrupted', timestamp);
    const turn: TranscriptTurn = {
      id: turnId,
      items: [],
      ...(timestamp ? { startedAt: timestamp } : {}),
      status: 'in-progress'
    };
    state.currentTurn = turn;
    state.turns.push(turn);
    trimTurns(state);
    events.push(statusEvent(threadId, turnId, 'active'));
    return;
  }
  if (!state.currentTurn) return;
  if (payload.type === 'task_complete' && payload.turn_id === state.currentTurn.id) {
    finishCurrentTurn(state, events, 'completed', timestamp);
    return;
  }
  if (payload.type !== 'user_message' && payload.type !== 'agent_message') return;
  if (payload.type === 'user_message' && typeof payload.client_id === 'string') {
    state.userMessageTurns.set(payload.client_id, state.currentTurn.id);
    if (state.userMessageTurns.size > 512) {
      const oldest = state.userMessageTurns.keys().next().value;
      if (oldest) state.userMessageTurns.delete(oldest);
    }
  }
  const rawText = typeof payload.message === 'string' ? payload.message : undefined;
  const text = visibleText(
    payload.type === 'user_message' ? cleanUserMessage(rawText) : rawText
  );
  if (!text) return;
  const role = payload.type === 'user_message' ? 'user-message' : 'agent-message';
  if (role === 'agent-message' && state.currentTurn.latestAssistantItemId) {
    completeAssistantItem(state.currentTurn, state.currentTurn.latestAssistantItemId, events);
  }
  const item: CodexConversationItemRecord = {
    id: transcriptItemId(state.currentTurn.id, role, record.timestamp, text),
    ...(role === 'user-message' && state.currentTurn.pendingUserImages?.length
      ? { images: state.currentTurn.pendingUserImages }
      : {}),
    kind: role,
    status: role === 'agent-message' ? 'in-progress' : 'completed',
    text
  };
  state.currentTurn.items.push(item);
  if (role === 'user-message') state.currentTurn.pendingUserImages = undefined;
  if (role === 'agent-message') state.currentTurn.latestAssistantItemId = item.id;
  events.push({
    eventId: eventId('item', threadId, state.currentTurn.id, item.id, item.status),
    item: { ...item },
    type: 'item'
  });
}

function finishCurrentTurn(
  state: TranscriptState,
  events: CodexSessionStreamEvent[],
  status: 'completed' | 'interrupted',
  completedAt?: string
) {
  const turn = state.currentTurn;
  if (!turn) return;
  if (turn.latestAssistantItemId) {
    completeAssistantItem(turn, turn.latestAssistantItemId, events);
  }
  completeActivityItems(turn, events);
  turn.status = status;
  if (completedAt) turn.completedAt = completedAt;
  state.currentTurn = undefined;
  events.push({
    eventId: eventId('turn-completed', turn.id, status, completedAt),
    turnId: turn.id,
    type: 'turn-completed'
  });
}

function processResponseItem(
  state: TranscriptState,
  payload: Record<string, unknown>,
  threadId: string,
  events: CodexSessionStreamEvent[]
) {
  const turn = state.currentTurn;
  if (!turn) return;
  const images = transcriptMessageImages(payload);
  if (images.length > 0) {
    const messageText = responseItemUserText(payload);
    const userItem = [...turn.items].reverse().find(
      (item) => item.kind === 'user-message' && item.text === messageText
    );
    if (!userItem) {
      turn.pendingUserImages = images;
      return;
    }
    userItem.images = images;
    events.push({
      eventId: eventId('item', threadId, turn.id, userItem.id, images.map((image) => image.id)),
      item: { ...userItem, images: images.map((image) => ({ ...image })) },
      type: 'item'
    });
    return;
  }
  const callId = identifier(payload.call_id);
  if (!callId) return;
  const type = typeof payload.type === 'string' ? payload.type : undefined;
  if (
    type === 'custom_tool_call_output' ||
    type === 'function_call_output' ||
    type === 'tool_search_output'
  ) {
    completeActivityItem(turn, activityItemId(turn.id, callId), events);
    return;
  }
  if (
    type !== 'custom_tool_call' &&
    type !== 'function_call' &&
    type !== 'tool_search_call'
  ) return;
  const description = safeTranscriptActivity(type, payload);
  const item: CodexConversationItemRecord = {
    detail: description.detail,
    id: activityItemId(turn.id, callId),
    kind: description.kind,
    status: 'in-progress'
  };
  const existingIndex = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (existingIndex >= 0) turn.items[existingIndex] = item;
  else turn.items.push(item);
  events.push({
    eventId: eventId('item', threadId, turn.id, item.id, item.status),
    item: { ...item },
    type: 'item'
  });
}

function responseItemUserText(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.content)) return undefined;
  const text = payload.content
    .flatMap((value) => (
      isRecord(value) &&
      value.type === 'input_text' &&
      typeof value.text === 'string'
        ? [value.text]
        : []
    ))
    .join('\n')
    .replace(/<image\b[^>]*>\s*/g, '')
    .replace(/\s*<\/image>/g, '');
  return visibleText(cleanUserMessage(text));
}

function completeActivityItems(
  turn: TranscriptTurn,
  events: CodexSessionStreamEvent[]
) {
  turn.items.forEach((item) => {
    if (
      item.kind !== 'agent-message' &&
      item.kind !== 'user-message' &&
      item.status !== 'completed'
    ) {
      completeActivityItem(turn, item.id, events);
    }
  });
}

function completeActivityItem(
  turn: TranscriptTurn,
  itemId: string,
  events: CodexSessionStreamEvent[]
) {
  const item = turn.items.find((candidate) => candidate.id === itemId);
  if (!item || item.status === 'completed') return;
  item.status = 'completed';
  events.push({
    eventId: eventId('item', turn.id, item.id, 'completed'),
    item: { ...item },
    type: 'item'
  });
}

function completeAssistantItem(
  turn: TranscriptTurn,
  itemId: string,
  events: CodexSessionStreamEvent[]
) {
  const item = turn.items.find((candidate) => candidate.id === itemId);
  if (!item || item.status === 'completed') return;
  item.status = 'completed';
  events.push({
    eventId: eventId('item', turn.id, item.id, 'completed'),
    item: { ...item },
    type: 'item'
  });
}

function trimTurns(state: TranscriptState) {
  if (state.turns.length <= MAXIMUM_VISIBLE_TURNS) return;
  state.turns.splice(0, state.turns.length - MAXIMUM_VISIBLE_TURNS);
}

function cleanUserMessage(value: string | undefined) {
  if (!value) return undefined;
  const requestMarker = '## My request for Codex:';
  const requestIndex = value.lastIndexOf(requestMarker);
  if (requestIndex >= 0) return value.slice(requestIndex + requestMarker.length).trim();
  return value
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/g, '')
    .trim();
}

function visibleText(value: string | undefined) {
  if (!value) return undefined;
  const clean = value.trim();
  if (!clean) return undefined;
  return scanProjectChatText(clean).safe
    ? clean.slice(0, MAXIMUM_VISIBLE_TEXT)
    : redactedText;
}

function statusEvent(
  threadId: string,
  turnId: string,
  status: 'active' | 'idle'
): CodexSessionStreamEvent {
  return {
    eventId: eventId('status', threadId, turnId, status),
    status,
    type: 'session-status'
  };
}

function transcriptItemId(turnId: string, role: string, timestamp: unknown, text: string) {
  return `transcript:${createHash('sha256')
    .update(JSON.stringify([turnId, role, timestamp, text]))
    .digest('hex')
    .slice(0, 24)}`;
}

function activityItemId(turnId: string, callId: string) {
  return `transcript:activity:${createHash('sha256')
    .update(JSON.stringify([turnId, callId]))
    .digest('hex')
    .slice(0, 24)}`;
}

function eventId(...parts: unknown[]) {
  return `transcript:${createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 24)}`;
}

function identifier(value: unknown) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function isoTimestamp(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function abortableDelay(duration: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, duration);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
