import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionRecord,
  CodexSessionStreamEvent,
  CodexSessionSubscribeRequest
} from '@/shared/codex-sessions-api';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  ProjectTopologyPreviewStream,
  type TopologyPreviewStreamClient
} from '../../src/features/project-topology/project-topology-preview-stream';
import {
  checkedAt,
  codex,
  inventory,
  session,
  snapshot
} from './project-topology-test-fixtures';
import type { TopologyTask } from '../../src/features/project-topology/project-topology-types';

describe('project topology preview transcript stream', () => {
  test('reads, resumes, and applies ordered real-ID events without synthetic turns', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const client = new PreviewClient(async () => readResult(candidate, 'Hello'));
    const store = new ProjectTopologyPreviewStream(client, fixedOptions());
    const observed: string[] = [];
    store.listen((state) => {
      observed.push(state.items.map((item) => item.text ?? '').join('|'));
    });

    store.start(modelTask(candidate));
    expect(store.getState().state).toBe('checking');
    await settle();

    expect(client.readRequests).toEqual([{ machineId: 'machine-a', threadId: 'thread-a' }]);
    expect(client.subscriptions[0]!.request).toEqual({
      afterSequence: 7,
      machineId: 'machine-a',
      threadId: 'thread-a'
    });
    expect(store.getState().state).toBe('ready');
    expect(store.getState().items.map((item) => item.id)).toEqual(['user-a', 'agent-a']);
    expect(store.getState().items[1]!.turnId).toBe('turn-a');

    client.event(0, {
      eventId: 'event-item',
      item: { id: 'status-a', kind: 'status', text: 'Working' },
      type: 'item'
    });
    client.event(0, {
      delta: ' world', eventId: 'event-delta-a', itemId: 'agent-a', type: 'agent-message-delta'
    });
    client.event(0, {
      delta: ' duplicate', eventId: 'event-delta-a', itemId: 'agent-a', type: 'agent-message-delta'
    });
    client.event(0, {
      delta: '!', eventId: 'event-delta-b', itemId: 'agent-a', type: 'agent-message-delta'
    });

    expect(store.getState().items.map((item) => item.id)).toEqual([
      'user-a', 'agent-a', 'status-a'
    ]);
    expect(store.getState().items[1]!.text).toBe('Hello world!');
    expect(store.getState().items[2]).not.toHaveProperty('turnId');
    expect(observed.at(-1)).toBe('Question|Hello world!|Working');
  });

  test('rejects mixed task or read identities before opening a stream', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const client = new PreviewClient(async () => readResult(
      { ...candidate, id: 'thread-b' },
      'Wrong task'
    ));
    const store = new ProjectTopologyPreviewStream(client, fixedOptions());
    const task = modelTask(candidate);

    store.start({ ...task, machineId: 'machine-b' } as TopologyTask);
    expect(store.getState().state).toBe('blocked');
    expect(client.readRequests).toHaveLength(0);

    store.start(task);
    await settle();
    expect(store.getState().state).toBe('blocked');
    expect(client.subscriptions).toHaveLength(0);
  });

  test('retains last-safe items and reconnects a failed stream with backoff', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    let readCount = 0;
    const client = new PreviewClient(async () => {
      readCount += 1;
      return readResult(candidate, readCount === 1 ? 'Hello' : 'Hello!', 7 + readCount - 1);
    });
    const scheduler = new TestScheduler();
    const store = new ProjectTopologyPreviewStream(client, {
      ...fixedOptions(),
      backoffMs: (attempt) => 100 * (attempt + 1),
      schedule: scheduler.schedule
    });
    store.start(modelTask(candidate));
    await settle();
    client.event(0, {
      delta: '!', eventId: 'event-live-a', itemId: 'agent-a', type: 'agent-message-delta'
    });

    client.fail(0, new Error('Connector disconnected.'));
    expect(store.getState()).toMatchObject({
      lastSafeAt: checkedAt,
      reason: 'Connector disconnected.',
      state: 'stale'
    });
    expect(store.getState().items[1]!.text).toBe('Hello!');
    expect(scheduler.delays).toEqual([100]);

    scheduler.runNext();
    await settle();
    expect(client.readRequests).toHaveLength(2);
    expect(client.subscriptions).toHaveLength(2);
    expect(client.subscriptions[1]!.request.afterSequence).toBe(8);
    client.event(1, {
      delta: ' duplicate', eventId: 'event-live-a', itemId: 'agent-a', type: 'agent-message-delta'
    });
    expect(store.getState().state).toBe('ready');
    expect(store.getState().items[1]!.text).toBe('Hello!');
    client.event(1, {
      delta: '?', eventId: 'event-live-b', itemId: 'agent-a', type: 'agent-message-delta'
    });
    expect(store.getState().state).toBe('ready');
    expect(store.getState().items[1]!.text).toBe('Hello!?');
  });

  test('refreshes its authoritative transcript and cursor after the replay ID window rolls over', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    let readCount = 0;
    const client = new PreviewClient(async () => {
      readCount += 1;
      return readCount === 1
        ? readResult(candidate, 'Before replay', 7)
        : readResult(candidate, 'Authoritative after replay', 508);
    });
    const scheduler = new TestScheduler();
    const store = new ProjectTopologyPreviewStream(client, {
      ...fixedOptions(), schedule: scheduler.schedule
    });
    store.start(modelTask(candidate));
    await settle();

    for (let index = 0; index < 501; index += 1) {
      client.event(0, {
        delta: '.',
        eventId: `event-replay-${index}`,
        itemId: 'agent-a',
        type: 'agent-message-delta'
      });
    }
    client.fail(0, new Error('Replay boundary disconnected.'));
    expect(store.getState().state).toBe('stale');

    scheduler.runNext();
    await settle();

    expect(client.readRequests).toHaveLength(2);
    expect(client.subscriptions[1]!.request.afterSequence).toBe(508);
    expect(store.getState().items[1]!.text).toBe('Authoritative after replay');
    client.event(1, {
      delta: '!', eventId: 'event-after-refresh', itemId: 'agent-a', type: 'agent-message-delta'
    });
    expect(store.getState().items[1]!.text).toBe('Authoritative after replay!');
  });

  test('retains last-safe items when a reread fails and retries the read', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    let readCount = 0;
    const client = new PreviewClient(async () => {
      readCount += 1;
      if (readCount === 2) throw new Error('Read timed out.');
      return readResult(candidate, readCount === 1 ? 'First' : 'Recovered');
    });
    const scheduler = new TestScheduler();
    const store = new ProjectTopologyPreviewStream(client, {
      ...fixedOptions(), schedule: scheduler.schedule
    });
    const task = modelTask(candidate);
    store.start(task);
    await settle();

    store.start(task);
    await settle();
    expect(store.getState()).toMatchObject({
      lastSafeAt: checkedAt,
      reason: 'Read timed out.',
      state: 'stale'
    });
    expect(store.getState().items[1]!.text).toBe('First');

    scheduler.runNext();
    await settle();
    expect(store.getState().state).toBe('ready');
    expect(store.getState().items[1]!.text).toBe('Recovered');
  });

  test('stop and dispose suppress late reads, events, errors, and reconnects', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    let resolveRead!: (result: CodexSessionReadResult) => void;
    const client = new PreviewClient(() => new Promise((resolve) => {
      resolveRead = resolve;
    }));
    const scheduler = new TestScheduler();
    const store = new ProjectTopologyPreviewStream(client, {
      ...fixedOptions(), schedule: scheduler.schedule
    });
    let callbackCount = 0;
    store.listen(() => { callbackCount += 1; });
    const task = modelTask(candidate);

    store.start(task);
    await Promise.resolve();
    const callbacksBeforeStop = callbackCount;
    store.stop();
    resolveRead(readResult(candidate, 'Late'));
    await settle();
    expect(client.subscriptions).toHaveLength(0);
    expect(callbackCount).toBe(callbacksBeforeStop);

    client.readHandler = async () => readResult(candidate, 'Current');
    store.start(task);
    await settle();
    const stateBeforeDispose = store.getState();
    store.dispose();
    client.event(0, {
      delta: ' late', eventId: 'event-late', itemId: 'agent-a', type: 'agent-message-delta'
    });
    client.fail(0, new Error('Late failure.'));
    expect(store.getState()).toBe(stateBeforeDispose);
    expect(scheduler.pending).toBe(0);
  });

  test('retries a cold-start read failure and becomes ready', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    let attempts = 0;
    const client = new PreviewClient(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Initial read failed.');
      return readResult(candidate, 'Recovered');
    });
    const scheduler = new TestScheduler();
    const store = new ProjectTopologyPreviewStream(client, {
      ...fixedOptions(), schedule: scheduler.schedule
    });

    store.start(modelTask(candidate));
    await settle();
    expect(store.getState()).toMatchObject({
      items: [],
      reason: 'Initial read failed.',
      state: 'blocked'
    });
    scheduler.runNext();
    await settle();

    expect(store.getState().state).toBe('ready');
    expect(store.getState().items[1]!.text).toBe('Recovered');
  });

  test('recovers from a synchronous subscribe failure without losing the read', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const client = new PreviewClient(async () => readResult(candidate, 'Safe read'));
    client.subscribeError = new Error('Subscribe failed.');
    const scheduler = new TestScheduler();
    const store = new ProjectTopologyPreviewStream(client, {
      ...fixedOptions(), schedule: scheduler.schedule
    });

    store.start(modelTask(candidate));
    await settle();
    expect(store.getState()).toMatchObject({
      reason: 'Subscribe failed.',
      state: 'stale'
    });
    expect(store.getState().items[1]!.text).toBe('Safe read');

    client.subscribeError = undefined;
    scheduler.runNext();
    await settle();
    expect(client.readRequests).toHaveLength(2);
    expect(client.subscriptions).toHaveLength(1);
  });

  test('increases backoff across repeated subscribe failures until a stream event arrives', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const client = new PreviewClient(async () => readResult(candidate, 'Safe read'));
    client.subscribeError = new Error('Subscribe failed.');
    const scheduler = new TestScheduler();
    const store = new ProjectTopologyPreviewStream(client, {
      ...fixedOptions(),
      backoffMs: (attempt) => 100 * (attempt + 1),
      schedule: scheduler.schedule
    });

    store.start(modelTask(candidate));
    await settle();
    scheduler.runNext();
    await settle();
    scheduler.runNext();
    await settle();

    expect(scheduler.delays).toEqual([100, 200, 300]);
    client.subscribeError = undefined;
    scheduler.runNext();
    await settle();
    client.event(0, {
      eventId: 'event-healthy',
      item: { id: 'status-healthy', kind: 'status', text: 'Connected' },
      type: 'item'
    });
    client.fail(0, new Error('Disconnected again.'));
    expect(scheduler.delays.at(-1)).toBe(100);
  });

  test('keeps ordered transcript items and ignores non-transcript decision events', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const client = new PreviewClient(async () => readResult(candidate, 'Hello'));
    const store = new ProjectTopologyPreviewStream(client, fixedOptions());
    store.start(modelTask(candidate));
    await settle();

    client.event(0, {
      eventId: 'event-user',
      item: { id: 'user-b', kind: 'user-message', text: 'Continue' },
      type: 'item'
    });
    client.event(0, {
      eventId: 'event-tool',
      item: { id: 'tool-a', kind: 'mcp-tool', status: 'in-progress', text: 'Browser' },
      type: 'item'
    });
    client.event(0, {
      eventId: 'event-status',
      item: { id: 'status-a', kind: 'status', text: 'Checking' },
      type: 'item'
    });
    client.event(0, {
      eventId: 'event-approval',
      kind: 'permissions',
      requestId: 'request-a',
      turnId: 'turn-a',
      type: 'approval-requested'
    });

    expect(store.getState().items.slice(-3).map((item) => item.kind)).toEqual([
      'user-message', 'mcp-tool', 'status'
    ]);
    expect(store.getState().items.some((item) => item.id === 'request-a')).toBe(false);
  });
});

class PreviewClient implements TopologyPreviewStreamClient {
  readonly readRequests: CodexSessionReadRequest[] = [];
  readonly subscriptions: Array<{
    onError?: (error: unknown) => void;
    onEvent: (event: CodexSessionStreamEvent) => void;
    request: CodexSessionSubscribeRequest;
    stopped: boolean;
  }> = [];
  subscribeError?: Error;

  constructor(
    public readHandler: (request: CodexSessionReadRequest) => Promise<CodexSessionReadResult>
  ) {}

  read(request: CodexSessionReadRequest) {
    this.readRequests.push(request);
    return this.readHandler(request);
  }

  subscribe(
    request: CodexSessionSubscribeRequest,
    onEvent: (event: CodexSessionStreamEvent) => void,
    onError?: (error: unknown) => void
  ) {
    if (this.subscribeError) throw this.subscribeError;
    const subscription = { onError, onEvent, request, stopped: false };
    this.subscriptions.push(subscription);
    return () => { subscription.stopped = true; };
  }

  event(index: number, event: CodexSessionStreamEvent) {
    this.subscriptions[index]?.onEvent(event);
  }

  fail(index: number, error: unknown) {
    this.subscriptions[index]?.onError?.(error);
  }
}

class TestScheduler {
  readonly delays: number[] = [];
  private readonly entries: Array<{ callback: () => void; cancelled: boolean }> = [];

  readonly schedule = (callback: () => void, delay: number) => {
    const entry = { callback, cancelled: false };
    this.delays.push(delay);
    this.entries.push(entry);
    return () => { entry.cancelled = true; };
  };

  get pending() {
    return this.entries.filter((entry) => !entry.cancelled).length;
  }

  runNext() {
    const entry = this.entries.find((candidate) => !candidate.cancelled);
    if (!entry) throw new Error('Expected a scheduled reconnect.');
    entry.cancelled = true;
    entry.callback();
  }
}

function modelTask(candidate: CodexSessionRecord) {
  return snapshot(buildProjectTopology(inventory({
    codexByMachine: {
      [candidate.machineId]: {
        checkedAt,
        data: codex(candidate.machineId, [candidate]),
        state: 'ready'
      }
    }
  }))).projects[0]!.machines[0]!.tasks[0]!;
}

function readResult(
  candidate: CodexSessionRecord,
  text: string,
  streamCursor = 7
): CodexSessionReadResult {
  return {
    openedReadOnly: true,
    session: candidate,
    streamCursor,
    turns: [{
      id: 'turn-a',
      items: [
        { id: 'user-a', kind: 'user-message', text: 'Question' },
        { id: 'agent-a', kind: 'agent-message', text }
      ],
      status: 'completed'
    }]
  };
}

function fixedOptions() {
  return { now: () => new Date(checkedAt) };
}

async function settle() {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}
