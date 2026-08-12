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
import { RuntimeSessionError } from './contracts';

const heartbeatIntervalSeconds = 15;
const staleAfterSeconds = 45;

interface ActiveConnection {
  connection: RuntimeSessionConnection;
  scope: RuntimeCredentialScope;
  sessionId: string;
}

export class WorkspaceRuntimeSessionService {
  private readonly connections = new Map<string, ActiveConnection>();

  constructor(
    private readonly store: RuntimeSessionStore,
    private readonly now = () => new Date(),
    private readonly createSessionId = randomUUID
  ) {}

  authenticate(token: string) {
    return this.store.authenticate(token);
  }

  issue(input: Parameters<RuntimeSessionStore['issue']>[0]) {
    return this.store.issue(input);
  }

  list(ownerUserId: string) {
    return this.store.list(ownerUserId);
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
    if (scope.capabilities.includes('runtime.codex.v1') ||
        readyCapabilities.some((capability) => !scope.requestedCapabilities.includes(capability)) ||
        codexReady !== (registration.resumeAfterCodexCommandSequence !== undefined) ||
        codexReady !== (registration.resumeAfterCodexEventSequence !== undefined)) {
      throw new RuntimeSessionError(
        'invalid_message',
        'Workspace Runtime ready authority was not requested by this credential.'
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
    this.connections.set(key, { connection, scope: activeScope, sessionId });
    if (previous && previous.connection !== connection) {
      previous.connection.close(1012, 'Workspace Runtime session replaced.');
    }
    const response: WorkspaceRuntimeServerMessage = {
      acceptedSequence: result.snapshot.lastSequence,
      heartbeatIntervalSeconds,
      replayed: false,
      schemaVersion: workspaceRuntimeSessionSchemaVersion,
      sessionId,
      snapshot: { ...result.snapshot, capabilities: [...activeScope.capabilities] },
      staleAfterSeconds,
      type: 'runtime.registered'
    };
    connection.send(JSON.stringify(response));
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

  acceptCodex(
    active: { scope: RuntimeCredentialScope; sessionId: string },
    message: WorkspaceRuntimeCodexMessage
  ) {
    if (!active.scope.capabilities.includes('runtime.codex.v1')) {
      throw new RuntimeSessionError('invalid_message', 'Workspace Runtime Codex authority is unavailable.');
    }
    return message;
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

export function runtimeSessionFailure(error: unknown) {
  if (error instanceof RuntimeSessionError) {
    return { code: 1008, reason: error.message };
  }
  return { code: 1011, reason: 'Workspace Runtime session failed.' };
}

function workspaceKey(ownerUserId: string, workspaceId: string) {
  return `${ownerUserId}\0${workspaceId}`;
}
