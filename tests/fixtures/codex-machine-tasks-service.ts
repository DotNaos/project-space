import {
  createCodexMachineTasksService,
  type CodexMachineTaskSendOperation,
  type CodexMachineTaskStartOperation,
  type CodexMachineTasksStore
} from '../../server/codex-machine-tasks/service';
import { CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY } from '../../src/shared/codex-machine-tasks-api';
import type { MachineRecord } from '../../src/shared/project-space-api';

export const threadId = '019f6d33-6aad-7302-a45e-bb7a33fc399c';

export function connector(): MachineRecord {
  return {
    connector: {
      capabilities: [CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY],
      installCommand: '',
      status: 'online'
    },
    id: 'connector-local',
    kind: 'connector',
    name: 'Local macOS',
    network: {},
    roles: [],
    sourcePath: ''
  };
}

export function taskSession(status: 'active' | 'idle' = 'idle') {
  return {
    archived: false,
    id: threadId,
    lastActivityAt: '2026-07-17T00:00:00.000Z',
    loadedByProjectSpace: false,
    machineId: 'connector-local',
    machineName: 'Local macOS',
    status,
    title: '#262'
  };
}

export function memoryStore(): CodexMachineTasksStore & {
  operations: Map<string, CodexMachineTaskStartOperation>;
  sends: Map<string, CodexMachineTaskSendOperation & {
    dispatchAttempt?: number;
    result?: Awaited<ReturnType<ReturnType<typeof service>['send']>>;
    state: 'completed' | 'pending' | 'queued' | 'uncertain';
  }>;
} {
  const operations = new Map<string, CodexMachineTaskStartOperation>();
  const sends = new Map<string, CodexMachineTaskSendOperation & {
    dispatchAttempt?: number;
    result?: Awaited<ReturnType<ReturnType<typeof service>['send']>>;
    state: 'completed' | 'pending' | 'queued' | 'uncertain';
  }>();
  return {
    operations,
    sends,
    async listQueuedSends() {
      return [...sends.values()].flatMap((operation) =>
        (operation.state === 'queued' ||
          (operation.state === 'pending' || operation.state === 'uncertain') &&
            operation.delivery === 'queue') &&
        operation.result?.state === 'queued'
        ? [{
            dispatchAttempt: operation.dispatchAttempt ?? 0,
            operation,
            result: operation.result,
            state: operation.state
          }]
        : []);
    },
    async findStart(input) {
      const current = [...operations.values()].find((candidate) => (
        candidate.userId === input.userId
        && candidate.connectorId === input.connectorId
        && candidate.startPayload.issue.number === input.issue
        && (candidate.startPayload.repository.id === input.repositoryId
          || candidate.startPayload.repository.nameWithOwner === input.repositoryId)
      ));
      if (!current) return { kind: 'missing' };
      if (current.state === 'completed' && current.result) {
        return { kind: 'confirmed', result: current.result };
      }
      return current.state === 'uncertain' ? { kind: 'uncertain' } : { kind: 'pending' };
    },
    async lookupStart(input) {
      const current = operations.get(input.operationId);
      if (!current) return { kind: 'missing' };
      if (current.fingerprint !== input.fingerprint) return { kind: 'conflict' };
      if (current.state === 'completed' && current.result) {
        return { kind: 'replayed', result: current.result };
      }
      return {
        connectorId: current.connectorId,
        durableOperations: current.durableOperations,
        generation: current.generation,
        kind: 'reserved',
        physicalMachineId: current.physicalMachineId,
        startPayload: current.startPayload,
        state: current.state === 'uncertain' ? 'uncertain' : 'pending'
      };
    },
    async lookupSend(input) {
      const current = sends.get(input.operationId);
      if (!current) return { kind: 'missing' };
      if (current.fingerprint !== input.fingerprint ||
          current.connectorId !== input.connectorId || current.threadId !== input.threadId) {
        return { kind: 'conflict' };
      }
      if (current.state === 'completed' && current.result) {
        return { kind: 'replayed', result: current.result };
      }
      if ((current.state === 'queued' ||
          (current.state === 'pending' || current.state === 'uncertain') &&
            current.delivery === 'queue') &&
          current.result?.state === 'queued') {
        return {
          dispatchAttempt: current.dispatchAttempt ?? 0,
          kind: 'queued',
          result: current.result,
          state: current.state
        };
      }
      return {
        dispatchDelivery: current.dispatchDelivery,
        durableOperations: current.durableOperations,
        ...(current.expectedTurnId ? { expectedTurnId: current.expectedTurnId } : {}),
        generation: current.generation,
        kind: 'reserved',
        state: current.state === 'uncertain' ? 'uncertain' : 'pending'
      };
    },
    async lookupSendRequest(input) {
      const current = sends.get(input.operationId);
      if (!current || !current.requestFingerprint) return { kind: 'missing' };
      if (current.requestFingerprint !== input.fingerprint) return { kind: 'conflict' };
      if (current.state === 'completed' && current.result) {
        return { kind: 'replayed', result: current.result };
      }
      if ((current.state === 'queued' ||
          (current.state === 'pending' || current.state === 'uncertain') &&
            current.delivery === 'queue') && current.result?.state === 'queued') {
        return {
          dispatchAttempt: current.dispatchAttempt ?? 0,
          kind: 'queued', result: current.result, state: current.state
        };
      }
      return {
        connectorId: current.connectorId,
        dispatchDelivery: current.dispatchDelivery,
        durableOperations: current.durableOperations,
        ...(current.expectedTurnId ? { expectedTurnId: current.expectedTurnId } : {}),
        generation: current.generation,
        kind: 'reserved',
        state: current.state === 'uncertain' ? 'uncertain' : 'pending'
      };
    },
    async releaseUncertainStart(input) {
      const current = operations.get(input.operationId);
      if (!current) return 'missing';
      if (current.fingerprint !== input.fingerprint) return 'conflict';
      if (current.state !== 'uncertain') return 'not_uncertain';
      for (const [operationId, candidate] of operations) {
        if (candidate.associationKey === current.associationKey) operations.delete(operationId);
      }
      return 'released';
    },
    async reserveSend(operation) {
      const current = sends.get(operation.operationId);
      if (current) {
        if (current.fingerprint !== operation.fingerprint ||
          current.connectorId !== operation.connectorId || current.threadId !== operation.threadId) {
          return { kind: 'conflict' };
        }
        if (current.state === 'completed' && current.result) {
          return { kind: 'replayed', result: current.result };
        }
        if (current.state === 'queued' && current.result?.state === 'queued') {
          return {
            dispatchAttempt: current.dispatchAttempt ?? 0,
            kind: 'queued',
            result: current.result,
            state: 'queued'
          };
        }
        if (current.state === 'pending' && current.delivery === 'queue' &&
            current.result?.state === 'queued') {
          return {
            dispatchAttempt: current.dispatchAttempt ?? 0,
            kind: 'queued',
            result: current.result,
            state: 'pending'
          };
        }
        if (current.state === 'uncertain' && current.delivery === 'queue' &&
            current.result?.state === 'queued') {
          return {
            dispatchAttempt: current.dispatchAttempt ?? 0,
            kind: 'queued',
            result: current.result,
            state: 'uncertain'
          };
        }
        return current.state === 'uncertain'
          ? {
              dispatchDelivery: current.dispatchDelivery,
              durableOperations: current.durableOperations,
              ...(current.expectedTurnId ? { expectedTurnId: current.expectedTurnId } : {}),
              generation: current.generation,
              kind: 'uncertain'
            }
          : {
              dispatchDelivery: current.dispatchDelivery,
              durableOperations: current.durableOperations,
              ...(current.expectedTurnId ? { expectedTurnId: current.expectedTurnId } : {}),
              generation: current.generation,
              kind: 'pending'
            };
      }
      if ([...sends.values()].some((candidate) => candidate.connectorId === operation.connectorId &&
        candidate.threadId === operation.threadId && candidate.state !== 'completed')) {
        return { kind: 'fenced' };
      }
      sends.set(operation.operationId, { ...operation, state: 'pending' });
      return { kind: 'new' };
    },
    async completeSend(operation, result) {
      sends.set(operation.operationId, { ...operation, result, state: 'completed' });
    },
    async markSendUncertain(operation) {
      sends.set(operation.operationId, { ...operation, state: 'uncertain' });
    },
    async queueSend(operation, result) {
      sends.set(operation.operationId, { ...operation, result, state: 'queued' });
    },
    async releaseSend(operation) {
      sends.delete(operation.operationId);
    },
    async resumeQueuedSend(operation) {
      const current = sends.get(operation.operationId);
      if (!current || current.state !== 'queued') return undefined;
      const dispatchAttempt = (current.dispatchAttempt ?? 0) + 1;
      sends.set(operation.operationId, {
        ...current, ...operation, dispatchAttempt, state: 'pending'
      });
      return dispatchAttempt;
    },
    async rebindQueuedSend(operation, generation) {
      const current = sends.get(operation.operationId);
      if (!current || current.state !== 'queued') return false;
      sends.set(operation.operationId, { ...current, generation });
      return true;
    },
    async reserveStart(operation) {
      const current = operations.get(operation.operationId);
      if (current) {
        return current.fingerprint === operation.fingerprint
          ? current.result
            ? { kind: 'replayed', result: current.result }
            : current.state === 'uncertain'
              ? {
                  dispatchOperationId: current.operationId,
                  durableOperations: current.durableOperations,
                  generation: current.generation,
                  kind: 'uncertain',
                  sameOperation: true,
                  startPayload: current.startPayload
                }
              : {
                  dispatchOperationId: current.operationId,
                  durableOperations: current.durableOperations,
                  generation: current.generation,
                  kind: 'pending',
                  sameOperation: true,
                  startPayload: current.startPayload
                }
          : { kind: 'conflict' };
      }
      const associated = [...operations.values()].find((candidate) => (
        candidate.associationKey === operation.associationKey
      ));
      if (associated?.result) return { kind: 'replayed', result: associated.result };
      if (associated?.state === 'uncertain') {
        return {
          dispatchOperationId: associated.operationId,
          durableOperations: associated.durableOperations,
          generation: associated.generation,
          kind: 'uncertain',
          sameOperation: false,
          startPayload: associated.startPayload
        };
      }
      if (associated) {
        return {
          dispatchOperationId: associated.operationId,
          durableOperations: associated.durableOperations,
          generation: associated.generation,
          kind: 'pending',
          sameOperation: false,
          startPayload: associated.startPayload
        };
      }
      operations.set(operation.operationId, operation);
      return { kind: 'new' };
    },
    async completeStart(operation, result) {
      const current = operations.get(operation.operationId);
      operations.set(operation.operationId, {
        ...operation,
        ...(current ? { fingerprint: current.fingerprint } : {}),
        result,
        state: 'completed'
      });
    },
    async markStartUncertain(operation) {
      const current = operations.get(operation.operationId);
      operations.set(operation.operationId, {
        ...operation,
        ...(current ? { fingerprint: current.fingerprint } : {}),
        state: 'uncertain'
      });
    },
    async releaseStart(operation) {
      operations.delete(operation.operationId);
    }
  };
}

export function service(options: {
  attachments?: {
    issue(): { endpointPath: string; expiresAt: string; token: string };
  };
  durableGenerationFor?: (connectorId: string, generation: number) => boolean;
  generationFor?: () => number;
  inventory?: () => Promise<{
    connectors: MachineRecord[];
    physicalMachines: Array<{ connectorIds: string[]; id: string; name: string }>;
  }>;
  issue?: () => Promise<{
    branch: string;
    commit: string;
    issue: { number: number; url: string };
    repository: { id: string; nameWithOwner: string };
  }>;
  read?: () => Promise<{
    openedReadOnly: true;
    session: ReturnType<typeof taskSession> & {
      activity?: { currentTurnId?: string };
    };
    turns: Array<{ id: string; status: 'in-progress' }>;
  }>;
  queueRetryDelay?: () => Promise<void>;
  send?: (input: {
    delivery: 'new-turn' | 'steer';
    expectedTurnId?: string;
    generation: number;
    operationId: string;
  }) => Promise<{
    operationId: string;
    reason?: 'thread_active' | 'unavailable';
    replayed: boolean;
    status: 'accepted' | 'ambiguous' | 'completed' | 'rejected';
    threadId: string;
    turnId?: string;
  }>;
  reconcileSend?: (input: {
    delivery: 'new-turn' | 'steer';
    expectedTurnId?: string;
    generation: number;
    operationId: string;
  }) => Promise<{
    operationId: string;
    reason?: 'thread_active' | 'unavailable';
    replayed: boolean;
    status: 'accepted' | 'ambiguous' | 'completed' | 'rejected';
    threadId: string;
    turnId?: string;
  }>;
  reconciledGeneration?: (input: { generation: number }) => number;
  start?: (input: {
    branch: string;
    commit: string;
    generation: number;
    issue: { number: number; url: string };
    operationId: string;
    reconcile: boolean;
    repository: { id: string; nameWithOwner: string };
  }) => Promise<
    | { state: 'confirmed'; threadId: string; worktreeId: string }
    | { state: 'offline' }
    | { message: string; state: 'codex_failure' | 'worktree_failure' }
    | { state: 'uncertain' }
  >;
  startedGeneration?: (input: { generation: number }) => number;
  store?: CodexMachineTasksStore;
  wait?: () => Promise<{ event: {
    eventId: string;
    requestId?: string;
    turnId?: string;
    type: 'approval-requested' | 'turn-completed' | 'user-input-requested';
  } }>;
} = {}) {
  return createCodexMachineTasksService({
    ...(options.attachments ? { attachments: options.attachments } : {}),
    inventory: options.inventory ?? (async () => ({
      connectors: [connector()],
      physicalMachines: [{ connectorIds: ['connector-local'], id: 'physical-local', name: 'Mac' }]
    })),
    issue: options.issue ?? (async () => ({
      branch: 'issue-262-build-codex-machine-task-core-and-cli',
      commit: 'a'.repeat(40),
      issue: { number: 262, url: 'https://github.com/DotNaos/project-space/issues/262' },
      repository: { id: 'R_test', nameWithOwner: 'DotNaos/project-space' }
    })),
    generationFor: options.generationFor ?? (() => 7),
    durableGenerationFor: options.durableGenerationFor ?? (() => true),
    sessions: {
      read: options.read ?? (async () => ({
        openedReadOnly: true as const,
        session: taskSession(),
        turns: []
      })),
      send: options.send ?? (async () => ({
        operationId: 'send-one',
        replayed: false,
        status: 'accepted',
        threadId,
        turnId: 'turn-one'
      })),
      ...(options.reconcileSend ? {
        async reconcileSend(input: { generation: number }) {
          return {
            generation: options.reconciledGeneration?.(input) ?? input.generation,
            result: await options.reconcileSend!(input)
          };
        }
      } : {}),
      wait: async (input) => ({
        result: await input.start(),
        ...(options.wait
          ? await options.wait()
          : { event: { eventId: 'done-one', turnId: 'turn-one', type: 'turn-completed' as const } })
      })
    },
    ...(options.queueRetryDelay ? { queueRetryDelay: options.queueRetryDelay } : {}),
    async start(input) {
      return {
        generation: options.startedGeneration?.(input) ?? input.generation,
        result: await (options.start?.(input) ?? Promise.resolve({
          state: 'confirmed' as const, threadId, worktreeId: 'wt_confirmed'
        }))
      };
    },
    store: options.store ?? memoryStore(),
    taskUrl: (machineId, id) => `https://projects.example/codex/machines/${machineId}/threads/${id}`
  });
}

export const request = {
  issue: 262,
  operationId: 'start-262-local',
  physicalMachineId: 'physical-local'
};
