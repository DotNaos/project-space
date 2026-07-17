import { describe, expect, test } from 'bun:test';

import {
  CodexTransportUncertainError,
  createCodexSessionsService,
  type CodexSessionsTransport
} from '../server/codex-sessions/service';
import type {
  CodexSessionInspectResult,
  CodexSessionListResult,
  CodexSessionReadResult
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
    title: '#177 · Topology command center',
    ...overrides
  };
}

function inspection(
  overrides: Partial<CodexSessionInspectResult> = {}
): CodexSessionInspectResult {
  const inspectedSession = overrides.session ?? session();
  const sessionRevision = overrides.sessionRevision ?? 'b'.repeat(64);
  return {
    checkedAt: '2026-07-13T10:00:30.000Z',
    openedReadOnly: true,
    session: inspectedSession,
    sessionRevision,
    taskLocation: {
      canonicalCwd: '/workspace/project-space',
      checkedAt: '2026-07-13T10:00:30.000Z',
      machineId,
      sessionRevision,
      source: 'connector-realpath',
      threadId,
      worktreeRoot: '/workspace/project-space'
    },
    ...overrides
  };
}

class InspectionStore {
  savedCheckedAt?: string;

  async appendEvent() { return 1; }
  async completeOperation() {}
  async latestEventSequence() { return 0; }
  async listEvents() { return []; }
  async listInventory() { return []; }
  async markOperationAmbiguous() {}
  async reconcileOperation() {}
  async reserveOperation() { return { kind: 'new' as const }; }
  async saveInventory(input: { checkedAt: string }) {
    this.savedCheckedAt = input.checkedAt;
  }
}

class InspectionTransport implements CodexSessionsTransport {
  inspectResult: CodexSessionInspectResult = inspection();
  inspectUsers: string[] = [];
  listResult: CodexSessionListResult = {
    checkedAt: '2026-07-13T09:00:00.000Z',
    machine: { id: machineId, name: 'MacBook', online: true },
    sessions: [session()]
  };
  readResult: CodexSessionReadResult = {
    openedReadOnly: true,
    session: session(),
    turns: [{ id: 'turn-1', items: [], status: 'completed' }]
  };

  async describeMachine() {
    return { id: machineId, name: 'MacBook', online: true };
  }

  async inspect(input: { userId: string }) {
    this.inspectUsers.push(input.userId);
    return structuredClone(this.inspectResult);
  }

  async list() {
    return structuredClone(this.listResult);
  }

  async mutate(): Promise<never> {
    throw new Error('not used');
  }

  async read() {
    return structuredClone(this.readResult);
  }
}

function serviceFor(
  store: InspectionStore,
  transport: InspectionTransport,
  options: { monotonicNow?: () => number; now?: () => Date } = {}
) {
  return createCodexSessionsService({
    authorize: async (requestActor, requestedMachineId) => {
      if (requestActor.userId !== actor.userId || requestedMachineId !== machineId) {
        throw new Error('not authorized');
      }
    },
    ...options,
    store,
    transport
  });
}

describe('Codex sessions inspection service', () => {
  test('preserves the connector acquisition window and read remains incapable of writing', async () => {
    const store = new InspectionStore();
    const transport = new InspectionTransport();
    transport.listResult = {
      checkedAt: '2026-07-13T09:00:00.000Z',
      machine: { id: machineId, name: 'MacBook', online: true },
      publishedAt: '2026-07-13T09:00:12.000Z',
      sessions: [session({ lastActivityAt: '2026-07-13T09:00:06.000Z' })]
    };
    const monotonicTimes = [100, 4_100];
    const service = serviceFor(store, transport, {
      monotonicNow: () => monotonicTimes.shift()!,
      now: () => new Date('2026-07-13T11:00:00.000Z')
    });

    const listed = await service.list(actor, { machineId });
    const opened = await service.read(actor, { machineId, threadId });

    expect(listed.checkedAt).toBe('2026-07-13T10:59:48.000Z');
    expect(listed.publishedAt).toBe('2026-07-13T11:00:00.000Z');
    expect(store.savedCheckedAt).toBe(listed.checkedAt);
    expect('writeCapability' in opened).toBe(false);
  });

  test('rejects a slow empty connector scan instead of saving fresh empty truth', async () => {
    const store = new InspectionStore();
    const transport = new InspectionTransport();
    transport.listResult = {
      checkedAt: '2026-07-13T09:00:00.000Z',
      machine: { id: machineId, name: 'MacBook', online: true },
      publishedAt: '2026-07-13T09:00:28.001Z',
      sessions: []
    };
    const monotonicTimes = [100, 110];
    const service = serviceFor(store, transport, {
      monotonicNow: () => monotonicTimes.shift()!,
      now: () => new Date('2026-07-13T11:00:00.000Z')
    });

    await expect(service.list(actor, { machineId }))
      .rejects.toBeInstanceOf(CodexTransportUncertainError);
    expect(store.savedCheckedAt).toBeUndefined();
  });

  test('authorizes interruption only for the inspected active turn and exact user', async () => {
    const store = new InspectionStore();
    const transport = new InspectionTransport();
    transport.inspectResult = inspection({
      activeTurnId: 'turn-active',
      session: session({ status: 'active' })
    });
    const opened = await serviceFor(store, transport, {
      now: () => new Date('2026-07-13T10:01:00.000Z')
    }).inspect(actor, { machineId, threadId });

    expect(opened.writeCapability).toMatchObject({
      canContinue: false,
      interruptTurnId: 'turn-active',
      machineId,
      sessionRevision: 'b'.repeat(64),
      state: 'ready',
      threadId
    });
    expect(transport.inspectUsers).toEqual([actor.userId]);
  });

  test('rejects slow inspection instead of minting a lease from stale evidence', async () => {
    const monotonicTimes = [100, 30_101];
    const service = serviceFor(new InspectionStore(), new InspectionTransport(), {
      monotonicNow: () => monotonicTimes.shift()!,
      now: () => new Date('2026-07-13T10:01:00.000Z')
    });

    await expect(service.inspect(actor, { machineId, threadId }))
      .rejects.toBeInstanceOf(CodexTransportUncertainError);
  });

  test('server-stamps inspection and tolerates small connector clock skew', async () => {
    const store = new InspectionStore();
    const transport = new InspectionTransport();
    transport.inspectResult = inspection({
      session: session({ lastActivityAt: '2026-07-13T10:01:20.000Z' })
    });
    const opened = await serviceFor(store, transport, {
      now: () => new Date('2026-07-13T10:01:00.000Z')
    }).inspect(actor, { machineId, threadId });

    expect(opened.checkedAt).toBe('2026-07-13T10:01:00.000Z');
    expect(opened.taskLocation.checkedAt).toBe(opened.checkedAt);
    expect(opened.writeCapability).toMatchObject({ state: 'ready' });
  });
});
