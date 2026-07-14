import type {
  CodexConversationItemRecord,
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionStreamEvent,
  CodexSessionSubscribeRequest
} from '@/shared/codex-sessions-api';
import { topologyTaskId, type TopologyTask } from './project-topology-types';

export interface TopologyPreviewStreamClient {
  read(request: CodexSessionReadRequest): Promise<CodexSessionReadResult>;
  subscribe(
    request: CodexSessionSubscribeRequest,
    onEvent: (event: CodexSessionStreamEvent) => void,
    onError?: (error: unknown) => void
  ): () => void;
}

export interface TopologyPreviewTranscriptItem extends CodexConversationItemRecord {
  turnId?: string;
  turnStatus?: CodexSessionReadResult['turns'][number]['status'];
}

interface PreviewStateBase {
  items: TopologyPreviewTranscriptItem[];
  lastSafeAt?: string;
}

export type TopologyPreviewStreamState =
  | (PreviewStateBase & { state: 'checking' })
  | (PreviewStateBase & { checkedAt: string; state: 'ready' })
  | (PreviewStateBase & { lastSafeAt: string; reason: string; state: 'stale' })
  | (PreviewStateBase & { reason: string; state: 'blocked' });

export interface TopologyPreviewStreamOptions {
  backoffMs?: (attempt: number) => number;
  now?: () => Date;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

type Listener = (state: TopologyPreviewStreamState) => void;
type Origin = { machineId: string; threadId: string };
type ReconnectKind = 'read' | 'stream';

export class ProjectTopologyPreviewStream {
  private active = false;
  private cancelReconnect?: () => void;
  private closeStream?: () => void;
  private connection = 0;
  private disposed = false;
  private generation = 0;
  private readonly listeners = new Set<Listener>();
  private origin?: Origin;
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private retryAttempt = 0;
  private state: TopologyPreviewStreamState = { items: [], state: 'checking' };
  private streamCursor?: number;

  private readonly backoffMs: (attempt: number) => number;
  private readonly now: () => Date;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;

  constructor(
    private readonly client: TopologyPreviewStreamClient,
    options: TopologyPreviewStreamOptions = {}
  ) {
    this.backoffMs = options.backoffMs ?? defaultBackoff;
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? defaultSchedule;
  }

  getState() {
    return this.state;
  }

  listen(listener: Listener) {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(task: TopologyTask) {
    if (this.disposed) return;
    this.cancelActiveWork();
    const origin = provenOrigin(task);
    if (!origin) {
      this.origin = undefined;
      this.publish({
        items: [],
        reason: 'The selected task does not have exact model-proven Codex identity evidence.',
        state: 'blocked'
      });
      return;
    }

    const sameOrigin = sameOriginAs(this.origin, origin);
    const items = sameOrigin ? this.state.items : [];
    const lastSafeAt = sameOrigin ? safeAt(this.state) : undefined;
    if (!sameOrigin) {
      this.seenEventIds.clear();
      this.seenEventOrder.length = 0;
    }
    this.origin = origin;
    this.streamCursor = undefined;
    this.retryAttempt = 0;
    this.active = true;
    const generation = ++this.generation;
    this.publish({ items, ...(lastSafeAt ? { lastSafeAt } : {}), state: 'checking' });
    this.readAndSubscribe(generation, origin);
  }

  stop() {
    this.cancelActiveWork();
  }

  dispose() {
    if (this.disposed) return;
    this.cancelActiveWork();
    this.disposed = true;
    this.listeners.clear();
  }

  private cancelActiveWork() {
    this.active = false;
    this.generation += 1;
    this.connection += 1;
    this.cancelReconnect?.();
    this.cancelReconnect = undefined;
    this.closeStream?.();
    this.closeStream = undefined;
  }

  private readAndSubscribe(generation: number, origin: Origin) {
    void Promise.resolve()
      .then(() => this.client.read(origin))
      .then((result) => {
        if (!this.isCurrent(generation, origin)) return;
        if (!validReadResult(result, origin)) {
          this.publish({
            items: [],
            reason: 'The transcript response did not match the selected Codex task.',
            state: 'blocked'
          });
          this.active = false;
          return;
        }
        const checkedAt = this.safeNow();
        const items = flattenReadItems(result);
        this.streamCursor = validCursor(result.streamCursor);
        this.publish({ checkedAt, items, lastSafeAt: checkedAt, state: 'ready' });
        this.openStream(generation, origin);
      })
      .catch((error) => {
        if (this.isCurrent(generation, origin)) {
          this.failAndReconnect(generation, origin, 'read', error);
        }
      });
  }

  private openStream(generation: number, origin: Origin) {
    if (!this.isCurrent(generation, origin)) return;
    const connection = ++this.connection;
    const request: CodexSessionSubscribeRequest = {
      ...origin,
      ...(this.streamCursor === undefined ? {} : { afterSequence: this.streamCursor })
    };
    let close = () => {};
    try {
      const returnedClose = this.client.subscribe(
        request,
        (event) => {
          if (!this.isCurrentConnection(generation, origin, connection)) return;
          this.acceptEvent(event);
        },
        (error) => {
          if (!this.isCurrentConnection(generation, origin, connection)) return;
          this.connection += 1;
          close();
          this.closeStream = undefined;
          this.failAndReconnect(generation, origin, 'stream', error);
        }
      );
      close = returnedClose;
      if (!this.isCurrentConnection(generation, origin, connection)) {
        returnedClose();
        return;
      }
      this.closeStream = returnedClose;
    } catch (error) {
      if (this.isCurrentConnection(generation, origin, connection)) {
        this.connection += 1;
        this.failAndReconnect(generation, origin, 'stream', error);
      }
    }
  }

  private acceptEvent(event: CodexSessionStreamEvent) {
    if (!validRuntimeId(event.eventId) || this.seenEventIds.has(event.eventId)) return;
    this.seenEventIds.add(event.eventId);
    this.seenEventOrder.push(event.eventId);
    if (this.seenEventOrder.length > 500) {
      const oldest = this.seenEventOrder.shift();
      if (oldest) this.seenEventIds.delete(oldest);
    }
    const items = applyEvent(this.state.items, event);
    const checkedAt = this.safeNow();
    this.retryAttempt = 0;
    this.publish({ checkedAt, items, lastSafeAt: checkedAt, state: 'ready' });
  }

  private failAndReconnect(
    generation: number,
    origin: Origin,
    kind: ReconnectKind,
    error: unknown
  ) {
    if (!this.isCurrent(generation, origin)) return;
    const reason = errorMessage(error, kind);
    const lastSafeAt = safeAt(this.state);
    this.publish(lastSafeAt
      ? { items: this.state.items, lastSafeAt, reason, state: 'stale' }
      : { items: [], reason, state: 'blocked' });
    this.cancelReconnect?.();
    const delay = safeDelay(this.backoffMs(this.retryAttempt++));
    this.cancelReconnect = this.schedule(() => {
      this.cancelReconnect = undefined;
      if (!this.isCurrent(generation, origin)) return;
      this.readAndSubscribe(generation, origin);
    }, delay);
  }

  private isCurrent(generation: number, origin: Origin) {
    return this.active
      && !this.disposed
      && this.generation === generation
      && sameOriginAs(this.origin, origin);
  }

  private isCurrentConnection(generation: number, origin: Origin, connection: number) {
    return this.isCurrent(generation, origin) && this.connection === connection;
  }

  private publish(state: TopologyPreviewStreamState) {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // A presentation callback cannot break transcript ordering or reconnect handling.
      }
    }
  }

  private safeNow() {
    const value = this.now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date(0).toISOString();
  }
}

function provenOrigin(task: TopologyTask): Origin | undefined {
  const validIdentity = task.id === topologyTaskId(task.machineId, task.threadId)
    && task.machineId === task.session.machineId
    && task.threadId === task.session.id;
  const validEvidence = task.evidence.source === 'connector-canonical-cwd'
    && cleanEvidence(task.cwd)
    && cleanEvidence(task.evidence.matchedPath);
  return validIdentity && validEvidence
    ? { machineId: task.machineId, threadId: task.threadId }
    : undefined;
}

function validReadResult(result: CodexSessionReadResult, origin: Origin) {
  return result.openedReadOnly === true
    && result.session.machineId === origin.machineId
    && result.session.id === origin.threadId;
}

function flattenReadItems(result: CodexSessionReadResult) {
  return result.turns.flatMap((turn) => turn.items.map<TopologyPreviewTranscriptItem>((item) => ({
    ...item,
    turnId: turn.id,
    turnStatus: turn.status
  })));
}

function applyEvent(
  current: TopologyPreviewTranscriptItem[],
  event: CodexSessionStreamEvent
) {
  if (event.type === 'item' && validRuntimeId(event.item.id)) {
    return upsert(current, event.item.id, (existing) => ({ ...existing, ...event.item }));
  }
  if (event.type === 'agent-message-delta' && validRuntimeId(event.itemId)) {
    return upsert(current, event.itemId, (existing) => ({
      ...existing,
      id: event.itemId,
      kind: 'agent-message',
      text: `${existing?.text ?? ''}${event.delta}`
    }));
  }
  return current;
}

function upsert(
  current: TopologyPreviewTranscriptItem[],
  itemId: string,
  update: (existing: TopologyPreviewTranscriptItem | undefined) => TopologyPreviewTranscriptItem
) {
  const index = current.findIndex((item) => item.id === itemId);
  if (index < 0) return [...current, update(undefined)];
  const items = [...current];
  items[index] = update(items[index]);
  return items;
}

function safeAt(state: TopologyPreviewStreamState) {
  return state.state === 'ready' ? state.checkedAt : state.lastSafeAt;
}

function sameOriginAs(left: Origin | undefined, right: Origin) {
  return left?.machineId === right.machineId && left.threadId === right.threadId;
}

function validCursor(value: number | undefined) {
  return Number.isSafeInteger(value) && value! >= 0 ? value : undefined;
}

function validRuntimeId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function cleanEvidence(value: string) {
  return Boolean(value && !/[\u0000-\u001f\u007f]/.test(value));
}

function safeDelay(value: number) {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 60_000) : 1_000;
}

function errorMessage(error: unknown, kind: ReconnectKind) {
  return error instanceof Error && error.message
    ? error.message
    : kind === 'read'
      ? 'The task transcript could not be read.'
      : 'The task transcript stream disconnected.';
}

function defaultBackoff(attempt: number) {
  return Math.min(250 * 2 ** Math.max(0, attempt), 10_000);
}

function defaultSchedule(callback: () => void, delayMs: number) {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}
