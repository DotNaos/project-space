import type {
  CodexSessionInspectRequest,
  CodexSessionReadRequest
} from '../../src/shared/codex-sessions-api';
import type { CodexSessionManager } from './manager';
import { presentCodexSession } from './public-presenter';
import {
  codexSessionRevision,
  resolveCodexTaskLocation,
  type CodexTaskLocationResolver
} from './task-access-evidence';
import { CodexThreadMissingError, type CodexSessionsTransport } from './service';
import type { LocalCodexTranscriptSource } from './transcript-reader';

interface LocalCodexTransportOptions {
  createInvalidResponseError(): Error;
  expectedGeneration(): number;
  expectedMachineId: string;
  inspectFallback(
    request: CodexSessionInspectRequest
  ): ReturnType<CodexSessionsTransport['inspect']>;
  machineName: string;
  manager: CodexSessionManager;
  mutate: CodexSessionsTransport['mutate'];
  now(): number;
  readFallback(
    request: CodexSessionReadRequest
  ): ReturnType<CodexSessionsTransport['read']>;
  resolveTaskLocation?: CodexTaskLocationResolver;
  streamFallback: NonNullable<CodexSessionsTransport['stream']>;
  threadId: string;
  transcript?: LocalCodexTranscriptSource;
}

export function createLocalCodexTransport(
  options: LocalCodexTransportOptions
): CodexSessionsTransport {
  const requireScope = (machineId: string, candidateThreadId?: string) => {
    if (
      machineId !== options.expectedMachineId ||
      (candidateThreadId !== undefined && candidateThreadId !== options.threadId)
    ) {
      throw new CodexThreadMissingError();
    }
  };
  return {
    describeMachine: async ({ machineId }) => {
      requireScope(machineId);
      return {
        id: options.expectedMachineId,
        name: options.machineName,
        online: true
      };
    },
    inspect: async (request) => {
      requireScope(request.machineId, request.threadId);
      if (!options.transcript) return options.inspectFallback(request);
      const checkedAt = new Date(options.now()).toISOString();
      const [snapshot, history] = await Promise.all([
        options.manager.readInspectionSnapshot(request.threadId, undefined, false),
        options.transcript.read(options.threadId)
      ]);
      const session = presentCodexSession(snapshot.thread, {
        archived: snapshot.thread.archived === true,
        loadedThreadIds: new Set(snapshot.loaded.data),
        machineId: options.expectedMachineId,
        machineName: options.machineName
      });
      session.status = history.active ? 'active' : session.status;
      if (!session.cwd) throw options.createInvalidResponseError();
      const taskLocation = await (
        options.resolveTaskLocation ?? resolveCodexTaskLocation
      )(session.cwd);
      const activeTurnId = history.active
        ? [...history.turns].reverse().find((turn) => turn.status === 'in-progress')?.id
        : undefined;
      const sessionRevision = codexSessionRevision({
        ...(activeTurnId ? { activeTurnId } : {}),
        connectorGeneration: options.expectedGeneration(),
        runtimeEpoch: snapshot.runtimeEpoch,
        session,
        taskLocation
      });
      return {
        ...(activeTurnId ? { activeTurnId } : {}),
        checkedAt,
        openedReadOnly: true,
        session,
        sessionRevision,
        taskLocation: {
          ...taskLocation,
          checkedAt,
          machineId: session.machineId,
          sessionRevision,
          source: 'connector-realpath',
          threadId: session.id
        }
      };
    },
    list: async ({ machineId }) => {
      requireScope(machineId);
      const [result, loaded, history] = await Promise.all([
        options.manager.readThread(options.threadId, false),
        options.manager.listLoadedThreads(),
        options.transcript?.read(options.threadId)
      ]);
      const checkedAt = new Date(options.now()).toISOString();
      return {
        checkedAt,
        machine: {
          id: options.expectedMachineId,
          name: options.machineName,
          online: true
        },
        publishedAt: checkedAt,
        sessions: [presentCodexSession({
          ...result.thread,
          ...(history?.active ? { status: { type: 'active' as const } } : {})
        }, {
          archived: result.thread.archived === true,
          loadedThreadIds: new Set(loaded.data),
          machineId: options.expectedMachineId,
          machineName: options.machineName
        })]
      };
    },
    mutate: async (request) => {
      requireScope(request.machineId, request.threadId);
      return options.mutate(request);
    },
    read: async (request) => {
      requireScope(request.machineId, request.threadId);
      if (!options.transcript) {
        const result = await options.readFallback(request);
        return {
          ...result,
          turns: result.turns.slice(-20).map((turn) => ({
            ...turn,
            items: turn.items.slice(-100)
          }))
        };
      }
      const [result, loaded, history] = await Promise.all([
        options.manager.readThread(options.threadId, false),
        options.manager.listLoadedThreads(),
        options.transcript.read(options.threadId)
      ]);
      const session = presentCodexSession({
        ...result.thread,
        ...(history.active ? { status: { type: 'active' as const } } : {})
      }, {
        archived: result.thread.archived === true,
        loadedThreadIds: new Set(loaded.data),
        machineId: options.expectedMachineId,
        machineName: options.machineName
      });
      const manager = options.manager as Partial<CodexSessionManager>;
      const profiles = await manager.listPermissionProfiles?.(session.cwd)
        .catch(() => undefined);
      const settings = manager.threadSettings?.(request.threadId);
      const tokenUsage = manager.threadTokenUsage?.(request.threadId);
      return {
        openedReadOnly: true,
        ...(settings?.permissionProfileId
          ? { permissionProfileId: settings.permissionProfileId }
          : {}),
        ...(profiles ? { permissionProfiles: profiles.data } : {}),
        session,
        ...(tokenUsage ? { tokenUsage } : {}),
        turns: history.turns
      };
    },
    stream: async (request, emit, signal) => {
      requireScope(request.machineId, request.threadId);
      if (!options.transcript) {
        await options.streamFallback(request, emit, signal);
        return;
      }
      let liveTurn = false;
      const live = options.streamFallback(request, (event) => {
        if (event.type === 'turn-completed' || (
          event.type === 'session-status' && event.status !== 'active'
        )) {
          liveTurn = false;
        } else {
          liveTurn = true;
        }
        emit(event);
      }, signal);
      const transcript = options.transcript.watch(options.threadId, (event) => {
        if (liveTurn && event.type === 'item') return;
        emit(event);
      }, signal);
      await Promise.all([live, transcript]);
    }
  };
}
