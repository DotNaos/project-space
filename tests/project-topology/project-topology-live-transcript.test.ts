import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionStreamEvent,
  CodexSessionSubscribeRequest
} from '@/shared/codex-sessions-api';
import {
  ProjectTopologyTranscriptRegistry,
  reconcileLiveTranscriptGeneration,
  topologyLiveTranscriptGenerationMismatchKey,
  topologyTaskWithLiveTranscript
} from '../../src/features/project-topology/project-topology-live-transcript';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import type { TopologyPreviewStreamClient } from '../../src/features/project-topology/project-topology-preview-stream';
import {
  checkedAt,
  codex,
  inventory,
  session,
  snapshot,
  writable
} from './project-topology-test-fixtures';
import { topologyTaskId } from '../../src/features/project-topology/project-topology-types';

describe('project topology live transcript registry', () => {
  test('shares one exact stream and stops only after the last visible consumer releases it', async () => {
    const task = modelTask();
    const client = new LiveClient(task.session);
    const registry = new ProjectTopologyTranscriptRegistry(client, {
      now: () => new Date(checkedAt)
    });
    const binding = registry.binding(task)!;

    const releaseNode = binding.retain(task);
    const releaseWorkspace = binding.retain(task);
    await settle();

    expect(client.readRequests).toEqual([{
      machineId: task.machineId,
      threadId: task.threadId
    }]);
    expect(client.subscriptions).toHaveLength(1);
    releaseNode();
    expect(client.subscriptions[0]!.stopped).toBe(false);
    releaseWorkspace();
    expect(client.subscriptions[0]!.stopped).toBe(true);

    const releaseAgain = binding.retain(task);
    await settle();
    expect(client.readRequests).toHaveLength(2);
    expect(client.subscriptions).toHaveLength(2);
    releaseAgain();
    registry.dispose();
  });

  test('never starts a connector read from stale task-location evidence', async () => {
    const task = modelTask();
    const client = new LiveClient(task.session);
    const registry = new ProjectTopologyTranscriptRegistry(client);
    const binding = registry.binding(task)!;
    const release = binding.retain({
      ...task,
      evidence: { ...task.evidence, current: false }
    });
    await settle();

    expect(client.readRequests).toHaveLength(0);
    expect(binding.getState()).toMatchObject({
      items: [],
      reason: 'The selected task does not have exact model-proven Codex identity evidence.',
      state: 'blocked'
    });
    release();
    registry.dispose();
  });

  test('restarts the exact stream when refreshed session status changes', async () => {
    const task = modelTask();
    const client = new LiveClient(task.session);
    const registry = new ProjectTopologyTranscriptRegistry(client, {
      now: () => new Date(checkedAt)
    });
    const binding = registry.binding(task)!;
    const releaseIdle = binding.retain(task);
    await settle();

    const releaseActive = binding.retain({
      ...task,
      session: { ...task.session, status: 'active' }
    });
    await settle();

    expect(client.readRequests).toHaveLength(2);
    expect(client.subscriptions[0]!.stopped).toBe(true);
    releaseIdle();
    releaseActive();
    registry.dispose();
  });

  test('preserves arrival order without inventing missing turn metadata', () => {
    const task = modelTask();
    const live = topologyTaskWithLiveTranscript(task, {
      checkedAt,
      items: [{
        id: 'agent-live',
        kind: 'agent-message',
        text: 'Live without a returned turn identity.'
      }, {
        id: 'status-live',
        kind: 'status',
        status: 'in-progress',
        text: 'Working'
      }],
      state: 'ready'
    });

    expect(live.transcript.state).toBe('ready');
    if (live.transcript.state === 'ready') {
      expect(live.transcript.data.map((item) => item.order)).toEqual([0, 1]);
      expect(live.transcript.data[0]).not.toHaveProperty('turnId');
      expect(live.transcript.data[0]).not.toHaveProperty('turnStatus');
    }
  });

  test('shows retained checking items as a stale last-safe transcript', () => {
    const task = modelTask();
    const live = topologyTaskWithLiveTranscript(task, {
      items: [{ id: 'agent-a', kind: 'agent-message', text: 'Last safe item' }],
      lastSafeAt: checkedAt,
      state: 'checking'
    });

    expect(live.transcript).toMatchObject({
      lastSafeAt: checkedAt,
      reason: 'The live transcript is reconnecting.',
      state: 'stale'
    });
  });

  test('retains the model transcript and revokes interaction while live evidence reconnects', () => {
    const task = writableModelTask();
    expect(task.interaction.composerVisible).toBe(true);

    for (const state of [{
      items: [],
      state: 'checking' as const
    }, {
      items: [],
      reason: 'Connector disconnected.',
      state: 'blocked' as const
    }]) {
      const live = topologyTaskWithLiveTranscript(task, state);
      expect(live.transcript).toMatchObject({
        data: task.transcript.state === 'ready' ? task.transcript.data : [],
        lastSafeAt: checkedAt,
        state: 'stale'
      });
      expect(live.interaction).toMatchObject({
        canContinue: false,
        canInterrupt: false,
        composerVisible: false
      });
    }
  });

  test('maps live decision state and revokes the prior task authority', () => {
    const task = writableModelTask();
    const live = topologyTaskWithLiveTranscript(task, {
      authorityInvalidation: {
        eventId: 'event-decision',
        reason: 'The live Codex task is awaiting a decision.'
      },
      awaitingDecision: true,
      checkedAt,
      items: [],
      session: task.session,
      sessionStatus: 'active',
      state: 'ready'
    });

    expect(live.activity).toBe('awaiting-decision');
    expect(live.session.status).toBe('active');
    expect(live.interaction.composerVisible).toBe(false);
    expect(live.interaction.reason).toBe('The live Codex task is awaiting a decision.');
  });

  test('reconciles a persistent generation mismatch once across transient refresh states', () => {
    const task = writableModelTask();
    const liveSession = {
      ...task.session,
      lastActivityAt: '2026-07-14T00:00:01.000Z',
      status: 'active' as const
    };
    const mismatch = topologyLiveTranscriptGenerationMismatchKey(task, {
      checkedAt: liveSession.lastActivityAt,
      items: [],
      session: liveSession,
      state: 'ready'
    });
    let refreshes = 0;
    const refresh = () => { refreshes += 1; };
    let notified = reconcileLiveTranscriptGeneration(undefined, mismatch, refresh);
    notified = reconcileLiveTranscriptGeneration(notified, mismatch, refresh);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      notified = reconcileLiveTranscriptGeneration(notified, undefined, refresh);
      notified = reconcileLiveTranscriptGeneration(notified, mismatch, refresh);
    }

    expect(mismatch).toBeString();
    expect(refreshes).toBe(1);

    const reconciledTask = { ...task, session: liveSession };
    const reconciled = topologyLiveTranscriptGenerationMismatchKey(reconciledTask, {
      checkedAt: liveSession.lastActivityAt,
      items: [],
      session: liveSession,
      state: 'ready'
    });
    notified = reconcileLiveTranscriptGeneration(notified, reconciled, refresh);
    reconcileLiveTranscriptGeneration(notified, mismatch, refresh);

    expect(reconciled).toBeNull();
    expect(refreshes).toBe(2);
  });
});

class LiveClient implements TopologyPreviewStreamClient {
  readonly readRequests: CodexSessionReadRequest[] = [];
  readonly subscriptions: Array<{
    request: CodexSessionSubscribeRequest;
    stopped: boolean;
  }> = [];

  constructor(private readonly session: ReturnType<typeof session>) {}

  async read(request: CodexSessionReadRequest): Promise<CodexSessionReadResult> {
    this.readRequests.push(request);
    return {
      openedReadOnly: true,
      session: this.session,
      streamCursor: 0,
      turns: []
    };
  }

  subscribe(
    request: CodexSessionSubscribeRequest,
    _onEvent: (event: CodexSessionStreamEvent) => void,
    _onError?: (error: unknown) => void
  ) {
    const subscription = { request, stopped: false };
    this.subscriptions.push(subscription);
    return () => { subscription.stopped = true; };
  }
}

function modelTask() {
  const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
  return snapshot(buildProjectTopology(inventory({
    codexByMachine: {
      'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
    }
  }))).projects[0]!.machines[0]!.tasks[0]!;
}

function writableModelTask() {
  const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
  const taskId = topologyTaskId(candidate.machineId, candidate.id);
  return snapshot(buildProjectTopology(inventory({
    codexByMachine: {
      'machine-a': { checkedAt, data: codex('machine-a', [candidate]), state: 'ready' }
    },
    conversations: {
      [taskId]: {
        checkedAt,
        data: {
          openedReadOnly: true,
          session: candidate,
          turns: [{
            id: 'turn-a',
            items: [{ id: 'agent-a', kind: 'agent-message', text: 'Last safe response' }],
            status: 'completed'
          }]
        },
        state: 'ready'
      }
    },
    writeCapabilities: { [taskId]: writable(candidate) }
  }))).projects[0]!.machines[0]!.tasks[0]!;
}

async function settle() {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}
