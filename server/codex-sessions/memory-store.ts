import type {
  CodexSessionOperationResult,
  CodexSessionRecord,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import {
  applyCodexActivityEvent,
  mergeCodexSessionEvidence
} from '../../src/shared/codex-task-activity';
import {
  operationFingerprint,
  type CodexStoredOperationInput,
  type CodexStoredOperationReservation
} from '../codex-sessions-store';

type StoredOperation = {
  fingerprint: string;
  result?: CodexSessionOperationResult;
  state: 'ambiguous' | 'completed' | 'pending';
};

export class MemoryCodexSessionsStore {
  private readonly events = new Map<
    string,
    Array<{ event: CodexSessionStreamEvent; sequence: number }>
  >();
  private readonly inventories = new Map<string, CodexSessionRecord[]>();
  private readonly operations = new Map<string, StoredOperation>();

  async saveInventory(input: {
    checkedAt: string;
    completeInventory: boolean;
    machineId: string;
    sessions: CodexSessionRecord[];
    userId: string;
  }) {
    const key = machineKey(input.userId, input.machineId);
    const current = new Map(
      (this.inventories.get(key) ?? []).map((session) => [session.id, session])
    );
    for (const session of input.sessions) {
      current.set(session.id, mergeCodexSessionEvidence(current.get(session.id), session));
    }
    if (input.completeInventory) {
      const received = new Set(input.sessions.map((session) => session.id));
      for (const [threadId, session] of current) {
        if (!received.has(threadId)) {
          current.set(threadId, {
            ...session,
            loadedByProjectSpace: false,
            status: 'missing'
          });
        }
      }
    }
    this.inventories.set(key, [...current.values()]);
  }

  async listInventory(userId: string, machineId: string) {
    return [...(this.inventories.get(machineKey(userId, machineId)) ?? [])];
  }

  async applyActivityEvent(input: {
    event: CodexSessionStreamEvent;
    machineId: string;
    sequence: number;
    threadId: string;
    userId: string;
  }) {
    const key = machineKey(input.userId, input.machineId);
    const sessions = this.inventories.get(key) ?? [];
    this.inventories.set(key, sessions.map((session) => {
      if (session.id !== input.threadId || !session.activity) return session;
      if (
        session.activity.eventSequence !== undefined
        && input.sequence <= session.activity.eventSequence
      ) return session;
      const activity = applyCodexActivityEvent(session.activity, input.event, input.sequence);
      return {
        ...session,
        activity,
        attention: activity.currentTurnState === 'waiting-for-approval'
          ? 'approval' as const
          : activity.currentTurnState === 'waiting-for-user'
            ? 'input' as const
            : undefined,
        lastActivityAt: activity.lastEventAt,
        status: activity.machineState === 'offline'
          ? 'offline' as const
          : activity.processState === 'failed'
            ? 'unavailable' as const
            : activity.conversationState === 'running' || activity.conversationState.startsWith('waiting-')
              ? 'active' as const
              : 'idle' as const
      };
    }));
  }

  async reserveOperation(
    input: CodexStoredOperationInput
  ): Promise<CodexStoredOperationReservation> {
    const key = operationKey(input);
    const fingerprint = operationFingerprint(input.fingerprint);
    const current = this.operations.get(key);
    if (!current) {
      this.operations.set(key, { fingerprint, state: 'pending' });
      return { kind: 'new' };
    }
    if (current.fingerprint !== fingerprint) return { kind: 'conflict' };
    if (current.state === 'ambiguous') return { kind: 'ambiguous' };
    if (current.state === 'completed' && current.result) {
      return { kind: 'replayed', result: { ...current.result, replayed: true } };
    }
    return { kind: 'pending' };
  }

  async completeOperation(
    input: CodexStoredOperationInput,
    result: CodexSessionOperationResult
  ) {
    this.operations.set(operationKey(input), {
      fingerprint: operationFingerprint(input.fingerprint),
      result,
      state: 'completed'
    });
  }

  async markOperationAmbiguous(input: CodexStoredOperationInput) {
    this.operations.set(operationKey(input), {
      fingerprint: operationFingerprint(input.fingerprint),
      state: 'ambiguous'
    });
  }

  async reconcileOperation(
    input: CodexStoredOperationInput,
    result: CodexSessionOperationResult
  ) {
    const current = this.operations.get(operationKey(input));
    if (current?.state === 'ambiguous') {
      this.operations.set(operationKey(input), {
        fingerprint: current.fingerprint,
        result,
        state: 'completed'
      });
    }
  }

  async appendEvent(input: {
    event: CodexSessionStreamEvent;
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    const key = sessionKey(input.userId, input.machineId, input.threadId);
    const current = this.events.get(key) ?? [];
    const existing = current.find((entry) => entry.event.eventId === input.event.eventId);
    if (existing) return existing.sequence;
    const sequence = (current.at(-1)?.sequence ?? 0) + 1;
    current.push({ event: input.event, sequence });
    this.events.set(key, current);
    return sequence;
  }

  async listEvents(input: {
    afterSequence?: number;
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    return (this.events.get(sessionKey(input.userId, input.machineId, input.threadId)) ?? [])
      .filter((entry) => entry.sequence > (input.afterSequence ?? 0))
      .slice(0, 500);
  }

  async latestEventSequence(input: {
    machineId: string;
    threadId: string;
    userId: string;
  }) {
    return this.events
      .get(sessionKey(input.userId, input.machineId, input.threadId))
      ?.at(-1)?.sequence ?? 0;
  }
}

function machineKey(userId: string, machineId: string) {
  return `${userId}\u0000${machineId}`;
}

function sessionKey(userId: string, machineId: string, threadId: string) {
  return `${machineKey(userId, machineId)}\u0000${threadId}`;
}

function operationKey(input: CodexStoredOperationInput) {
  return `${sessionKey(input.userId, input.machineId, input.threadId)}\u0000${input.operationId}`;
}
