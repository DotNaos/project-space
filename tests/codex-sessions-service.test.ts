import { describe, expect, test } from 'bun:test';

import {
  CodexSessionsAccessError,
  CodexSessionsConflictError,
  CodexTransportUnavailableError,
  CodexTransportUncertainError,
  CodexThreadMissingError,
  createCodexSessionsService,
  type CodexSessionsTransport
} from '../server/codex-sessions/service';
import type {
  CodexStoredOperationInput,
  CodexStoredOperationReservation
} from '../server/codex-sessions-store';
import type {
  CodexSessionBrowserResult,
  CodexSessionContinueRequest,
  CodexSessionListResult,
  CodexSessionOperationResult,
  CodexSessionReadResult,
  CodexSessionStreamEvent
} from '../src/shared/codex-sessions-api';

const actor = { userId: 'user-a' };
const machineId = 'machine-a';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';

function session(overrides: Partial<CodexSessionListResult['sessions'][number]> = {}) {
  return {
    archived: false,
    cwd: '/workspace/project-space',
    id: threadId,
    lastActivityAt: '2026-07-13T10:00:00.000Z',
    loadedByProjectSpace: true,
    machineId,
    machineName: 'MacBook',
    model: 'gpt-5',
    status: 'idle' as const,
    title: '#149 · Integrate Codex sessions',
    ...overrides
  };
}

function inventory(overrides: Partial<CodexSessionListResult> = {}): CodexSessionListResult {
  return {
    checkedAt: '2026-07-13T10:01:00.000Z',
    machine: { id: machineId, name: 'MacBook', online: true },
    sessions: [session()],
    ...overrides
  };
}

function history(overrides: Partial<CodexSessionReadResult> = {}): CodexSessionReadResult {
  return {
    openedReadOnly: true,
    session: session(),
    turns: [{ id: 'turn-1', items: [], status: 'completed' }],
    ...overrides
  };
}

class MemoryStore {
  readonly access = new Set([`${actor.userId}\0${machineId}`]);
  readonly events = new Map<string, CodexSessionStreamEvent[]>();
  readonly inventories = new Map<string, CodexSessionListResult>();
  readonly operations = new Map<string, {
    fingerprint: string;
    result?: CodexSessionOperationResult;
    state: 'ambiguous' | 'completed' | 'pending';
  }>();
  async saveInventory(input: {
    checkedAt: string;
    completeInventory: boolean;
    machineId: string;
    sessions: CodexSessionListResult['sessions'];
    userId: string;
  }) {
    this.inventories.set(this.machineKey(input), inventory({
      checkedAt: input.checkedAt,
      sessions: structuredClone(input.sessions)
    }));
  }

  async listInventory(userId: string, requestedMachineId: string) {
    return structuredClone(
      this.inventories.get(this.machineKey({ machineId: requestedMachineId, userId }))?.sessions ?? []
    );
  }

  async reserveOperation(input: CodexStoredOperationInput): Promise<CodexStoredOperationReservation> {
    const key = this.operationKey(input);
    const existing = this.operations.get(key);
    const fingerprint = JSON.stringify(input.fingerprint);
    if (!existing) {
      this.operations.set(key, { fingerprint, state: 'pending' });
      return { kind: 'new' };
    }
    if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
    if (existing.state === 'completed') return { kind: 'replayed', result: existing.result! };
    if (existing.state === 'ambiguous') return { kind: 'ambiguous' };
    return { kind: 'pending' };
  }

  async completeOperation(input: CodexStoredOperationInput, result: CodexSessionOperationResult) {
    this.operations.set(this.operationKey(input), {
      fingerprint: JSON.stringify(input.fingerprint),
      result: structuredClone(result),
      state: 'completed'
    });
  }

  async markOperationAmbiguous(input: CodexStoredOperationInput) {
    this.operations.set(this.operationKey(input), {
      fingerprint: JSON.stringify(input.fingerprint),
      state: 'ambiguous'
    });
  }

  async reconcileOperation(input: CodexStoredOperationInput, result: CodexSessionOperationResult) {
    await this.completeOperation(input, result);
  }

  async appendEvent(input: {
    event: CodexSessionStreamEvent;
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    const key = this.sessionKey(input);
    const events = this.events.get(key) ?? [];
    if (!events.some((event) => event.eventId === input.event.eventId)) {
      events.push(structuredClone(input.event));
    }
    this.events.set(key, events);
    return events.findIndex((event) => event.eventId === input.event.eventId) + 1;
  }

  async listEvents(input: {
    afterSequence?: number;
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    const events = structuredClone(this.events.get(this.sessionKey(input)) ?? []);
    return events
      .map((event, index) => ({ event, sequence: index + 1 }))
      .filter(({ sequence }) => sequence > (input.afterSequence ?? 0))
      .slice(0, 500);
  }

  async latestEventSequence(input: {
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    return (this.events.get(this.sessionKey(input)) ?? []).length;
  }

  private machineKey(input: { machineId: string; userId: string }) {
    return `${input.userId}\0${input.machineId}`;
  }

  private sessionKey(input: { machineId: string; threadId: string; userId: string }) {
    return `${this.machineKey(input)}\0${input.threadId}`;
  }

  private operationKey(input: { machineId: string; operationId: string; threadId: string; userId: string }) {
    return `${this.machineKey(input)}\0${input.threadId}\0${input.operationId}`;
  }
}

function authorize(store: MemoryStore) {
  return async (requestActor: { userId: string }, requestedMachineId: string) => {
    if (!store.access.has(`${requestActor.userId}\0${requestedMachineId}`)) {
      throw new CodexSessionsAccessError('You do not have access to this machine.');
    }
  };
}

class FakeTransport implements CodexSessionsTransport {
  browserUsers: string[] = [];
  listScopes: Array<{ machineId: string; userId: string }> = [];
  liveEvents: CodexSessionStreamEvent[] = [];
  mutationUsers: string[] = [];
  mutationGenerations: Array<number | undefined> = [];
  readGenerations: Array<number | undefined> = [];
  readUsers: string[] = [];
  streamUsers: string[] = [];
  streamGenerations: Array<number | undefined> = [];
  listResult: CodexSessionListResult | Error = inventory();
  readResult: CodexSessionReadResult | Error = history();
  browserResult: CodexSessionBrowserResult | Error = {
    checkedAt: '2026-07-13T10:01:00.000Z',
    imageDataUrl: 'data:image/jpeg;base64,c2FmZQ==',
    imageRevision: 'a'.repeat(64),
    machineId,
    pageUrl: 'https://example.test',
    state: 'live',
    threadId,
    turnId: 'turn-1'
  };
  mutationCalls = 0;
  mutationResult:
    | Error
    | {
        machineId: string;
        result: CodexSessionOperationResult;
        threadId: string;
      } = {
        machineId,
        result: {
          operationId: 'operation-1',
          replayed: false,
          status: 'accepted',
          threadId,
          turnId: 'turn-2'
        },
        threadId
      };
  mutationWait?: Promise<void>;

  async describeMachine({ machineId: requestedMachineId }: { machineId: string }) {
    return { id: requestedMachineId, name: 'MacBook', online: false };
  }

  async browser(input: { userId: string }) {
    this.browserUsers.push(input.userId);
    if (this.browserResult instanceof Error) throw this.browserResult;
    return structuredClone(this.browserResult);
  }

  async list(scope: { machineId: string; userId: string }) {
    this.listScopes.push(scope);
    if (this.listResult instanceof Error) throw this.listResult;
    return structuredClone(this.listResult);
  }

  async read(input: { connectorGeneration?: number; userId: string }) {
    this.readUsers.push(input.userId);
    this.readGenerations.push(input.connectorGeneration);
    if (this.readResult instanceof Error) throw this.readResult;
    return structuredClone(this.readResult);
  }

  async mutate(input: { request: { connectorGeneration?: number }; userId: string }) {
    this.mutationUsers.push(input.userId);
    this.mutationGenerations.push(input.request.connectorGeneration);
    this.mutationCalls++;
    await this.mutationWait;
    if (this.mutationResult instanceof Error) throw this.mutationResult;
    return structuredClone(this.mutationResult);
  }

  async stream(
    input: { connectorGeneration?: number; userId: string },
    emit: (event: CodexSessionStreamEvent) => void,
    signal: AbortSignal
  ) {
    this.streamUsers.push(input.userId);
    this.streamGenerations.push(input.connectorGeneration);
    this.liveEvents.forEach(emit);
    if (signal.aborted) return;
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
      once: true
    }));
  }
}

function continuation(operationId = 'operation-1'): CodexSessionContinueRequest {
  return { machineId, message: 'Continue safely', operationId, threadId };
}

function serviceFor(store: MemoryStore, transport: FakeTransport, now?: () => Date) {
  return createCodexSessionsService({ authorize: authorize(store), now, store, transport });
}

describe('Codex sessions hosted service', () => {
  test('preserves a trusted exact connector generation through read, mutation, and stream', async () => {
    const transport = new FakeTransport();
    const service = serviceFor(new MemoryStore(), transport);
    await service.read(actor, { connectorGeneration: 12, machineId, threadId });
    await service.continue(actor, { ...continuation(), connectorGeneration: 12 });
    const controller = new AbortController();
    controller.abort();
    await service.transportStream(
      actor,
      { connectorGeneration: 12, machineId, threadId },
      controller.signal
    );
    expect(transport.readGenerations).toEqual([12]);
    expect(transport.mutationGenerations).toEqual([12]);
    expect(transport.streamGenerations).toEqual([12]);
  });

  test('saves a complete online inventory and serves an honest offline snapshot', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.listResult = inventory({ inventoryState: 'stale' });
    const service = createCodexSessionsService({
      authorize: authorize(store),
      now: () => new Date('2026-07-13T11:00:00.000Z'),
      store,
      transport
    });

    const online = await service.list(actor, { machineId, search: 'integrate' });
    expect(online.inventoryState).toBe('live');
    expect(online.sessions).toHaveLength(1);
    expect(await store.listInventory(actor.userId, machineId)).toHaveLength(1);

    transport.listResult = new CodexTransportUnavailableError('disconnected');
    const offline = await service.list(actor, { machineId });
    expect(offline.inventoryState).toBe('stale');
    expect(offline.machine).toMatchObject({ id: machineId, online: false });
    expect(offline.sessions[0]).toMatchObject({ loadedByProjectSpace: false, status: 'offline' });
    expect(offline.machine.statusMessage).toContain('last saved');
  });

  test('keeps reads read-only and returns safe missing and offline history states', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const service = serviceFor(store, transport);

    await service.publishEvent(actor, { machineId, threadId }, {
      eventId: 'event-before-read', status: 'active', type: 'session-status'
    });
    const opened = await service.read(actor, { machineId, threadId });
    expect(opened.openedReadOnly).toBe(true);
    expect(opened.streamCursor).toBe(1);
    transport.readResult = new CodexTransportUnavailableError('offline');
    const cached = await service.read(actor, { machineId, threadId });
    expect(cached).toMatchObject({ openedReadOnly: true, session: { status: 'offline' }, streamCursor: 1 });
    expect(cached.turns).toHaveLength(0);

    const missingTransport = new FakeTransport();
    missingTransport.readResult = new CodexThreadMissingError('gone');
    const missingStore = new MemoryStore();
    const missing = await serviceFor(missingStore, missingTransport)
      .read(actor, { machineId, threadId });
    expect(missing).toMatchObject({ openedReadOnly: true, session: { id: threadId, status: 'missing' }, turns: [] });
  });

  test('enforces user and machine isolation before transport access', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const service = serviceFor(store, transport);

    await expect(service.list({ userId: 'user-b' }, { machineId })).rejects.toBeInstanceOf(CodexSessionsAccessError);
    await expect(service.read(actor, { machineId: 'machine-b', threadId })).rejects.toBeInstanceOf(CodexSessionsAccessError);
    await expect(service.browser(actor, { machineId: 'machine-b', threadId })).rejects.toBeInstanceOf(CodexSessionsAccessError);
    expect(transport.browserUsers).toHaveLength(0);
    expect(transport.mutationCalls).toBe(0);
  });

  test('binds every connector operation to the authorized user', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const service = serviceFor(store, transport);

    await service.list(actor, { machineId });
    await service.read(actor, { machineId, threadId });
    await service.browser(actor, { machineId, threadId });
    await service.continue(actor, continuation());

    expect(transport.listScopes).toEqual([{ machineId, userId: actor.userId }]);
    expect(transport.readUsers).toEqual([actor.userId]);
    expect(transport.browserUsers).toEqual([actor.userId]);
    expect(transport.mutationUsers).toEqual([actor.userId]);
  });

  test('strips browser frames from history and rejects cross-task browser results', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.readResult = history({ browser: transport.browserResult as CodexSessionBrowserResult });
    const service = serviceFor(store, transport);

    expect(await service.read(actor, { machineId, threadId })).not.toHaveProperty('browser');
    transport.browserResult = {
      ...(transport.browserResult as CodexSessionBrowserResult),
      threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9b'
    };
    await expect(service.browser(actor, { machineId, threadId }))
      .rejects.toBeInstanceOf(CodexTransportUncertainError);
  });

  test('preserves a sanitized final frame for an ended browser session', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.browserResult = {
      checkedAt: '2026-07-13T10:01:00.000Z',
      imageDataUrl: 'data:image/jpeg;base64,c2FmZQ==',
      imageRevision: 'b'.repeat(64),
      machineId,
      pageUrl: 'https://example.test',
      reason: 'The browser activity for this turn has ended.',
      state: 'ended',
      threadId,
      turnId: 'turn-1'
    };

    expect(await serviceFor(store, transport).browser(actor, { machineId, threadId }))
      .toEqual(transport.browserResult);
  });

  test('accepts an unchanged frame only for the exact requested image revision', async () => {
    const transport = new FakeTransport();
    transport.browserResult = {
      checkedAt: '2026-07-13T10:01:00.000Z',
      imageRevision: 'a'.repeat(64),
      imageUnchanged: true,
      machineId,
      pageUrl: 'https://example.test',
      state: 'live',
      threadId,
      turnId: 'turn-1'
    };
    const service = serviceFor(new MemoryStore(), transport);

    await expect(service.browser(actor, {
      afterImageRevision: 'a'.repeat(64),
      machineId,
      threadId
    })).resolves.toEqual(transport.browserResult);
    await expect(service.browser(actor, {
      afterImageRevision: 'b'.repeat(64),
      machineId,
      threadId
    })).rejects.toBeInstanceOf(CodexTransportUncertainError);
  });

  test('surfaces browser transport outages so clients can preserve reconnect state', async () => {
    const transport = new FakeTransport();
    transport.browserResult = new CodexTransportUnavailableError('connector offline');

    await expect(serviceFor(new MemoryStore(), transport).browser(actor, { machineId, threadId }))
      .rejects.toBeInstanceOf(CodexTransportUnavailableError);
  });

  test('joins simultaneous operations and durably replays the completed result', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    let release = () => {};
    transport.mutationWait = new Promise<void>((resolve) => { release = resolve; });
    const service = serviceFor(store, transport);

    const first = service.continue(actor, continuation());
    const second = service.continue(actor, continuation());
    await Promise.resolve();
    release();
    expect(await first).toMatchObject({ replayed: false, status: 'accepted' });
    expect(await second).toMatchObject({ replayed: false, status: 'accepted' });
    expect(transport.mutationCalls).toBe(1);

    const restarted = serviceFor(store, transport);
    expect(await restarted.continue(actor, continuation())).toMatchObject({ replayed: true, status: 'accepted' });
    expect(transport.mutationCalls).toBe(1);
  });

  test('rejects conflicting input while the original operation is still running', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    let release = () => {};
    transport.mutationWait = new Promise<void>((resolve) => { release = resolve; });
    const service = serviceFor(store, transport);

    const first = service.continue(actor, continuation('operation-in-flight'));
    await Promise.resolve();
    await expect(service.continue(actor, {
      ...continuation('operation-in-flight'),
      message: 'Conflicting input'
    })).rejects.toBeInstanceOf(CodexSessionsConflictError);
    release();
    await first;
    expect(transport.mutationCalls).toBe(1);
  });

  test('does not treat a connector reconnect as changed operation input', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const service = serviceFor(store, transport);
    const request = { ...continuation('operation-generation'), connectorGeneration: 7 };

    expect(await service.continue(actor, request)).toMatchObject({ replayed: false });
    expect(await service.continue(actor, { ...request, connectorGeneration: 8 }))
      .toMatchObject({ replayed: true });
    expect(transport.mutationCalls).toBe(1);
  });

  test('rejects conflicting reuse and marks uncertain or wrong-target results ambiguous', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const service = serviceFor(store, transport);

    await service.continue(actor, continuation());
    await expect(service.continue(actor, { ...continuation(), message: 'different' })).rejects.toBeInstanceOf(CodexSessionsConflictError);

    const uncertainTransport = new FakeTransport();
    uncertainTransport.mutationResult = new CodexTransportUncertainError('socket replaced');
    const uncertainStore = new MemoryStore();
    const uncertain = await serviceFor(uncertainStore, uncertainTransport)
      .continue(actor, continuation('operation-2'));
    expect(uncertain).toMatchObject({ operationId: 'operation-2', replayed: false, status: 'ambiguous' });

    const offlineTransport = new FakeTransport();
    offlineTransport.mutationResult = new CodexTransportUnavailableError('offline before dispatch');
    const offlineStore = new MemoryStore();
    const offlineService = serviceFor(offlineStore, offlineTransport);
    expect(await offlineService.continue(actor, continuation('operation-offline')))
      .toMatchObject({ replayed: false, status: 'rejected' });
    expect(await offlineService.continue(actor, continuation('operation-offline')))
      .toMatchObject({ replayed: true, status: 'rejected' });

    const wrongTransport = new FakeTransport();
    wrongTransport.mutationResult = {
      machineId: 'machine-b',
      result: { operationId: 'operation-3', replayed: false, status: 'accepted', threadId },
      threadId
    };
    const wrongStore = new MemoryStore();
    const wrong = await serviceFor(wrongStore, wrongTransport)
      .continue(actor, continuation('operation-3'));
    expect(wrong.status).toBe('ambiguous');
  });

  test('turns orphaned pending operations ambiguous after a service restart', async () => {
    const store = new MemoryStore();
    await store.reserveOperation({
      fingerprint: {
        kind: 'continue',
        request: { machineId, message: 'Continue safely', operationId: undefined, threadId },
        threadId
      },
      machineId,
      operation: 'continue',
      operationId: 'operation-1',
      threadId,
      userId: actor.userId
    });
    const transport = new FakeTransport();
    const result = await serviceFor(store, transport).continue(actor, continuation());
    expect(result).toMatchObject({ replayed: true, status: 'ambiguous' });
    expect(transport.mutationCalls).toBe(0);
  });

  test('conservatively reconciles an ambiguous continuation through the connector ledger', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    transport.mutationResult = new CodexTransportUncertainError('result frame was lost');
    const service = serviceFor(store, transport);
    const request = continuation('operation-reconcile');

    expect(await service.continue(actor, request)).toMatchObject({ status: 'ambiguous' });
    transport.mutationResult = {
      machineId,
      result: {
        operationId: request.operationId,
        replayed: false,
        status: 'accepted',
        threadId,
        turnId: 'turn-reconciled'
      },
      threadId
    };
    expect(await service.reconcileContinue(actor, request)).toMatchObject({
      replayed: true,
      status: 'accepted',
      turnId: 'turn-reconciled'
    });
    expect(await service.continue(actor, request)).toMatchObject({
      replayed: true,
      status: 'accepted',
      turnId: 'turn-reconciled'
    });
    expect(transport.mutationCalls).toBe(2);
  });

  test('replays persisted events, deduplicates reconnects, and then streams live events', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const service = serviceFor(store, transport);
    const first = { eventId: 'event-1', status: 'idle', type: 'session-status' } as const;
    const second = { eventId: 'event-2', itemId: 'item-1', delta: 'Hello', type: 'agent-message-delta' } as const;
    const third = { eventId: 'event-3', turnId: 'turn-2', type: 'turn-completed' } as const;
    await service.publishEvent(actor, { machineId, threadId }, first);
    await service.publishEvent(actor, { machineId, threadId }, second);

    const received: CodexSessionStreamEvent[] = [];
    const controller = new AbortController();
    const streaming = service.stream(
      actor,
      { afterSequence: 1, machineId, threadId },
      (event) => received.push(event),
      controller.signal
    );
    await Promise.resolve();
    await service.publishEvent(actor, { machineId, threadId }, second);
    await service.publishEvent(actor, { machineId, threadId }, third);
    controller.abort();
    await streaming;
    expect(received.map((event) => event.eventId)).toEqual(['event-2', 'event-3']);
  });

  test('persists connector events before delivering them and cancels the owning stream', async () => {
    const store = new MemoryStore();
    const transport = new FakeTransport();
    const event = {
      delta: 'Live response',
      eventId: 'live-event-1',
      itemId: 'item-live',
      type: 'agent-message-delta'
    } as const;
    transport.liveEvents = [event, event];
    const service = serviceFor(store, transport);
    const received: string[] = [];
    const controller = new AbortController();

    const browser = service.stream(
      actor,
      { machineId, threadId },
      (next) => received.push(next.eventId),
      controller.signal
    );
    const connector = service.transportStream(actor, { machineId, threadId }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await Promise.all([browser, connector]);

    expect(received).toEqual(['live-event-1']);
    expect(transport.streamUsers).toEqual([actor.userId]);
    expect((await store.listEvents({ machineId, threadId, userId: actor.userId })))
      .toHaveLength(1);
  });

  test('pages through more than 500 persisted events during reconnect replay', async () => {
    const store = new MemoryStore();
    const service = serviceFor(store, new FakeTransport());
    for (let index = 1; index <= 501; index++) {
      await store.appendEvent({
        event: {
          eventId: `event-${index}`,
          status: 'idle',
          type: 'session-status'
        },
        machineId,
        threadId,
        userId: actor.userId
      });
    }
    const received: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await service.stream(
      actor,
      { machineId, threadId },
      (event) => received.push(event.eventId),
      controller.signal
    );
    expect(received).toHaveLength(501);
    expect(received.at(-1)).toBe('event-501');
  });
});
