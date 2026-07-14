import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionStreamEvent,
  CodexSessionSubscribeRequest
} from '@/shared/codex-sessions-api';
import { CodexPublicEventPresenter } from '../../server/codex-sessions/public-presenter';
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

describe('project topology preview status events', () => {
  test('invalidates each active occurrence when the real presenter reuses its status ID', async () => {
    const candidate = session('machine-a', 'thread-a', '/projects/project-space', 'idle');
    const presenter = new CodexPublicEventPresenter();
    const activeFirst = statusEvent(presenter, candidate.id, 'active');
    const idle = statusEvent(presenter, candidate.id, 'idle');
    const activeAgain = statusEvent(presenter, candidate.id, 'active');
    const client = new StatusClient(candidate);
    const stream = new ProjectTopologyPreviewStream(client, {
      now: () => new Date(checkedAt)
    });
    const invalidations: string[] = [];
    stream.listen((state) => {
      if (state.authorityInvalidation) {
        invalidations.push(state.authorityInvalidation.eventId);
      }
    });

    expect(activeFirst.eventId).toBe(activeAgain.eventId);
    expect(activeFirst.eventId).not.toBe(idle.eventId);

    stream.start(modelTask(candidate));
    await settle();
    client.emit(activeFirst);
    client.emit(idle);
    client.emit(activeAgain);

    expect(stream.getState()).toMatchObject({
      authorityInvalidation: { eventId: activeFirst.eventId },
      sessionStatus: 'active'
    });
    expect(invalidations).toEqual([
      activeFirst.eventId,
      idle.eventId,
      activeAgain.eventId
    ]);
  });
});

class StatusClient implements TopologyPreviewStreamClient {
  private onEvent?: (event: CodexSessionStreamEvent) => void;

  constructor(private readonly candidate: ReturnType<typeof session>) {}

  async read(_request: CodexSessionReadRequest): Promise<CodexSessionReadResult> {
    return {
      openedReadOnly: true,
      session: this.candidate,
      streamCursor: 0,
      turns: []
    };
  }

  subscribe(
    _request: CodexSessionSubscribeRequest,
    onEvent: (event: CodexSessionStreamEvent) => void
  ) {
    this.onEvent = onEvent;
    return () => { this.onEvent = undefined; };
  }

  emit(event: CodexSessionStreamEvent) {
    this.onEvent?.(event);
  }
}

function statusEvent(
  presenter: CodexPublicEventPresenter,
  threadId: string,
  status: 'active' | 'idle'
) {
  const event = presenter.present({
    kind: 'notification',
    method: 'thread/status/changed',
    params: { status: { type: status }, threadId }
  });
  if (!event || event.type !== 'session-status') {
    throw new Error(`Expected a public ${status} session status event.`);
  }
  return event;
}

function modelTask(candidate: ReturnType<typeof session>) {
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

async function settle() {
  for (let count = 0; count < 8; count += 1) await Promise.resolve();
}
