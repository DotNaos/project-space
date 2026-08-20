import { randomUUID } from 'node:crypto';

import {
  workspaceRuntimeSessionSchemaVersion,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeRegistration,
  type WorkspaceRuntimeServerMessage,
  type WorkspaceRuntimeSessionSnapshot
} from '../../src/shared/workspace-runtime-session-api';
import type {
  RuntimeCredentialScope,
  RuntimeSessionConnection,
  RuntimeSessionStore
} from './contracts';
import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../../src/shared/workspace-runtime-codex-api';
import type {
  WorkspaceRuntimeControlCommand,
  WorkspaceRuntimeControlMessage
} from '../../src/shared/workspace-runtime-control-api';
import {
  canonicalRuntimeControlAccessMode,
  type CanonicalRuntimeControlOperation
} from '../../src/shared/canonical-runtime-control-api';
import {
  workspaceRuntimeControlCapability,
  workspaceRuntimeMutationCapability
} from '../../src/shared/workspace-runtime-session-api';
import { RuntimeSessionError } from './contracts';

const heartbeatIntervalSeconds = 15;
const staleAfterSeconds = 45;

interface ActiveConnection {
  connection: RuntimeSessionConnection;
  codexAcceptedCommandSequence: number;
  scope: RuntimeCredentialScope;
  sessionId: string;
}

export class WorkspaceRuntimeSessionService {
  private readonly connections = new Map<string, ActiveConnection>();
  private readonly codexListeners = new Set<(
    message: WorkspaceRuntimeCodexMessage
  ) => Promise<void> | void>();
  private readonly controlListeners = new Set<(
    message: WorkspaceRuntimeControlMessage
  ) => Promise<void> | void>();
  private readonly controlRegistrationListeners = new Set<(input: {
    generation: string;
    ownerUserId: string;
    resumeAfterCommandSequence: number;
    sessionId: string;
    workspaceId: string;
  }) => Promise<void> | void>();

  constructor(
    private readonly store: RuntimeSessionStore,
    private readonly now = () => new Date(),
    private readonly createSessionId = randomUUID,
    private readonly controlWatermarks?: {
      read(ownerUserId: string, workspaceId: string, generation: string): Promise<{
        eventSequence: number;
        commandSequence: number;
      } | undefined>;
    }
  ) {}

  authenticate(token: string) {
    return this.store.authenticate(token);
  }

  issue(input: Parameters<RuntimeSessionStore['issue']>[0]) {
    return this.store.issue(input);
  }

  async list(ownerUserId: string) {
    const snapshots = await this.store.list(ownerUserId);
    return snapshots.map((snapshot) => {
      const active = this.connections.get(workspaceKey(ownerUserId, snapshot.workspaceId));
      return active?.sessionId === snapshot.sessionId &&
        active.scope.generation === snapshot.generation
        ? {
            ...snapshot,
            capabilities: [...active.scope.capabilities],
            codexAcceptedCommandSequence: active.codexAcceptedCommandSequence
          }
        : snapshot;
    });
  }

  async revoke(ownerUserId: string, workspaceId: string, credentialId: string) {
    await this.store.revoke(ownerUserId, workspaceId, credentialId);
    const key = workspaceKey(ownerUserId, workspaceId);
    const active = this.connections.get(key);
    if (active?.scope.credentialId === credentialId) {
      this.connections.delete(key);
      active.connection.close(1008, 'Workspace Runtime credential revoked.');
    }
  }

  async register(
    connection: RuntimeSessionConnection,
    scope: RuntimeCredentialScope,
    registration: WorkspaceRuntimeRegistration
  ) {
    const readyCapabilities = registration.readyCapabilities ?? [];
    const codexReady = readyCapabilities.includes('runtime.codex.v1');
    const controlReady = readyCapabilities.some((capability) =>
      capability === workspaceRuntimeControlCapability ||
      capability === workspaceRuntimeMutationCapability
    );
    if (scope.capabilities.includes('runtime.codex.v1') ||
        readyCapabilities.some((capability) => !scope.requestedCapabilities.includes(capability)) ||
        codexReady !== (registration.resumeAfterCodexCommandSequence !== undefined) ||
        codexReady !== (registration.resumeAfterCodexEventSequence !== undefined) ||
        controlReady !== (registration.resumeAfterControlCommandSequence !== undefined) ||
        controlReady !== (registration.resumeAfterControlEventSequence !== undefined)) {
      throw new RuntimeSessionError(
        'invalid_message',
        'Workspace Runtime ready authority was not requested by this credential.'
      );
    }
    const controlWatermark = controlReady
      ? await this.controlWatermarks?.read(scope.ownerUserId, scope.workspaceId, scope.generation)
      : undefined;
    if (controlReady && (!controlWatermark ||
      registration.resumeAfterControlCommandSequence! > controlWatermark.commandSequence ||
      registration.resumeAfterControlEventSequence! < controlWatermark.eventSequence)) {
      throw new RuntimeSessionError(
        'sequence_conflict',
        'Workspace Runtime control resume evidence changed.'
      );
    }
    const sessionId = this.createSessionId();
    const receivedAt = this.now().toISOString();
    const result = await this.store.register(scope, sessionId, receivedAt, registration);
    const activeScope: RuntimeCredentialScope = {
      ...scope,
      capabilities: [...new Set([...scope.capabilities, ...readyCapabilities])].sort()
    };
    const key = workspaceKey(scope.ownerUserId, scope.workspaceId);
    const previous = this.connections.get(key);
    const codexAcceptedCommandSequence = registration.resumeAfterCodexCommandSequence ?? 0;
    this.connections.set(key, {
      codexAcceptedCommandSequence,
      connection,
      scope: activeScope,
      sessionId
    });
    if (previous && previous.connection !== connection) {
      previous.connection.close(1012, 'Workspace Runtime session replaced.');
    }
    const response: WorkspaceRuntimeServerMessage = {
      ...(controlWatermark ? {
        acceptedControlEventSequence: controlWatermark.eventSequence
      } : {}),
      acceptedSequence: result.snapshot.lastSequence,
      heartbeatIntervalSeconds,
      replayed: false,
      schemaVersion: workspaceRuntimeSessionSchemaVersion,
      sessionId,
      snapshot: {
        ...result.snapshot,
        capabilities: [...activeScope.capabilities],
        codexAcceptedCommandSequence
      },
      staleAfterSeconds,
      type: 'runtime.registered'
    };
    connection.send(JSON.stringify(response));
    if (controlReady) {
      for (const listener of this.controlRegistrationListeners) await listener({
        generation: scope.generation,
        ownerUserId: scope.ownerUserId,
        resumeAfterCommandSequence: registration.resumeAfterControlCommandSequence!,
        sessionId,
        workspaceId: scope.workspaceId
      });
    }
    return { scope: activeScope, sessionId };
  }

  async append(active: { scope: RuntimeCredentialScope; sessionId: string }, event: WorkspaceRuntimeEvent) {
    const receivedAt = this.now().toISOString();
    const result = await this.store.append(active.scope, active.sessionId, receivedAt, event);
    const response: WorkspaceRuntimeServerMessage = {
      acceptedSequence: result.snapshot.lastSequence,
      heartbeatIntervalSeconds,
      replayed: result.replayed,
      schemaVersion: workspaceRuntimeSessionSchemaVersion,
      sessionId: active.sessionId,
      staleAfterSeconds,
      type: 'runtime.accepted'
    };
    return { response, stopped: result.snapshot.lifecycleState === 'stopped' };
  }

  async acceptCodex(
    active: { scope: RuntimeCredentialScope; sessionId: string },
    message: WorkspaceRuntimeCodexMessage
  ) {
    if (!active.scope.capabilities.includes('runtime.codex.v1')) {
      throw new RuntimeSessionError('invalid_message', 'Workspace Runtime Codex authority is unavailable.');
    }
    const connection = this.connections.get(workspaceKey(active.scope.ownerUserId, active.scope.workspaceId));
    if (connection?.sessionId === active.sessionId &&
        message.commandSequence > connection.codexAcceptedCommandSequence) {
      connection.codexAcceptedCommandSequence = message.commandSequence;
    }
    for (const listener of this.codexListeners) await listener(message);
    return message;
  }

  onCodexMessage(listener: (message: WorkspaceRuntimeCodexMessage) => Promise<void> | void) {
    this.codexListeners.add(listener);
    return () => this.codexListeners.delete(listener);
  }

  async acceptControl(
    active: { scope: RuntimeCredentialScope; sessionId: string },
    message: WorkspaceRuntimeControlMessage
  ) {
    if (!active.scope.capabilities.includes(controlCapability(message.operation))) {
      throw new RuntimeSessionError('invalid_message', 'Workspace Runtime control authority is unavailable.');
    }
    for (const listener of this.controlListeners) await listener(message);
    return message;
  }

  onControlMessage(listener: (message: WorkspaceRuntimeControlMessage) => Promise<void> | void) {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  onControlRegistration(listener: (input: {
    generation: string;
    ownerUserId: string;
    resumeAfterCommandSequence: number;
    sessionId: string;
    workspaceId: string;
  }) => Promise<void> | void) {
    this.controlRegistrationListeners.add(listener);
    return () => this.controlRegistrationListeners.delete(listener);
  }

  dispatchCodex(ownerUserId: string, command: WorkspaceRuntimeCodexCommand) {
    const active = this.connections.get(workspaceKey(ownerUserId, command.workspaceId));
    if (!active || !active.scope.capabilities.includes('runtime.codex.v1') ||
        active.scope.ownerUserId !== ownerUserId || command.actorUserId !== ownerUserId ||
        command.environmentId !== active.scope.environmentId ||
        command.generation !== active.scope.generation || command.sessionId !== active.sessionId) {
      throw new RuntimeSessionError('generation_replaced', 'Workspace Runtime Codex generation is unavailable.');
    }
    active.connection.send(JSON.stringify(command));
  }

  dispatchControl(ownerUserId: string, command: WorkspaceRuntimeControlCommand) {
    const active = this.connections.get(workspaceKey(ownerUserId, command.workspaceId));
    if (!active || !active.scope.capabilities.includes(controlCapability(command.operation)) ||
        active.scope.ownerUserId !== ownerUserId || command.actorUserId !== ownerUserId ||
        command.environmentId !== active.scope.environmentId ||
        command.generation !== active.scope.generation || command.sessionId !== active.sessionId) {
      throw new RuntimeSessionError(
        'generation_replaced',
        'Workspace Runtime control generation is unavailable.'
      );
    }
    active.connection.send(JSON.stringify(command));
  }

  acknowledgeControl(ownerUserId: string, message: WorkspaceRuntimeControlMessage) {
    const active = this.connections.get(workspaceKey(ownerUserId, message.workspaceId));
    if (!active || active.scope.ownerUserId !== ownerUserId ||
        message.actorUserId !== ownerUserId || message.environmentId !== active.scope.environmentId ||
        message.generation !== active.scope.generation || message.sessionId !== active.sessionId) {
      throw new RuntimeSessionError(
        'generation_replaced', 'Workspace Runtime control acknowledgement target changed.'
      );
    }
    active.connection.send(JSON.stringify({
      acceptedControlEventSequence: message.eventSequence,
      type: 'runtime.control.accepted'
    }));
  }

  async disconnect(active: { scope: RuntimeCredentialScope; sessionId: string }) {
    const key = workspaceKey(active.scope.ownerUserId, active.scope.workspaceId);
    const registered = this.connections.get(key);
    if (registered?.sessionId === active.sessionId) this.connections.delete(key);
    await this.store.disconnect(active.scope, active.sessionId, this.now().toISOString());
  }

  async expireStale() {
    const checkedAt = this.now();
    const staleBefore = new Date(checkedAt.getTime() - staleAfterSeconds * 1_000).toISOString();
    const stale = await this.store.markStale(staleBefore, checkedAt.toISOString());
    for (const entry of stale) this.closeSnapshot(
      entry.ownerUserId, entry.snapshot, 1008, 'Workspace Runtime heartbeat expired.'
    );
    return stale;
  }

  close() {
    for (const active of this.connections.values()) {
      active.connection.close(1001, 'Project Space is shutting down.');
    }
    this.connections.clear();
    this.codexListeners.clear();
    this.controlListeners.clear();
    this.controlRegistrationListeners.clear();
  }

  closeExpired(scope: RuntimeCredentialScope, connection: RuntimeSessionConnection) {
    const delay = Math.max(0, Date.parse(scope.expiresAt) - this.now().getTime());
    return setTimeout(() => connection.close(1008, 'Workspace Runtime credential expired.'), delay);
  }

  private closeSnapshot(
    ownerUserId: string,
    snapshot: WorkspaceRuntimeSessionSnapshot,
    code: number,
    reason: string
  ) {
    const active = this.connections.get(workspaceKey(ownerUserId, snapshot.workspaceId));
    if (active?.scope.generation !== snapshot.generation || active.sessionId !== snapshot.sessionId) return;
    if (active) {
      this.connections.delete(workspaceKey(active.scope.ownerUserId, active.scope.workspaceId));
      active.connection.close(code, reason);
    }
  }
}

function controlCapability(operation: CanonicalRuntimeControlOperation) {
  return canonicalRuntimeControlAccessMode(operation) === 'mutation'
    ? workspaceRuntimeMutationCapability
    : workspaceRuntimeControlCapability;
}

export function runtimeSessionFailure(error: unknown) {
  if (error instanceof RuntimeSessionError) {
    return { code: 1008, reason: error.message };
  }
  return { code: 1011, reason: 'Workspace Runtime session failed.' };
}

function workspaceKey(ownerUserId: string, workspaceId: string) {
  return `${ownerUserId}\0${workspaceId}`;
}
