import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  workspaceRuntimeSessionSchemaVersion,
  type WorkspaceRuntimeCredential,
  type WorkspaceRuntimeEvent,
  type WorkspaceRuntimeRegistration,
  type WorkspaceRuntimeSessionSnapshot
} from '../../src/shared/workspace-runtime-session-api';
import type {
  IssueRuntimeCredentialInput,
  RuntimeCredentialScope,
  RuntimeSessionClock,
  RuntimeSessionRecord,
  RuntimeSessionStore
} from './contracts';
import { RuntimeSessionError } from './contracts';
import { validateCredentialIssue } from './validation';

interface StoredCredential extends RuntimeCredentialScope {
  operationId: string;
  revokedAt?: string;
  tokenHash: string;
}

const systemClock: RuntimeSessionClock = { now: () => new Date() };

export class MemoryRuntimeSessionStore implements RuntimeSessionStore {
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly currentCredentials = new Map<string, string>();
  private readonly operationCredentials = new Map<string, StoredCredential>();
  private readonly records = new Map<string, RuntimeSessionRecord>();

  constructor(
    private readonly clock: RuntimeSessionClock = systemClock,
    private readonly createCredentialId = randomUUID,
    private readonly createToken = () => randomBytes(32).toString('base64url')
  ) {}

  async issue(input: IssueRuntimeCredentialInput) {
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + validateCredentialIssue(input) * 1_000).toISOString();
    const operationKey = `${input.ownerUserId}\0${input.operationId}`;
    const operationCredential = this.operationCredentials.get(operationKey);
    if (operationCredential) {
      if (!sameIssue(operationCredential, input)) {
        throw new RuntimeSessionError('replay_conflict', 'Runtime launch operation identity changed.');
      }
      throw new RuntimeSessionError('operation_in_progress', 'Runtime launch operation is already in progress.');
    }
    const token = this.createToken();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').byteLength !== 32) {
      throw new Error('Runtime credential token must contain 32 random bytes.');
    }
    const credentialId = this.createCredentialId();
    const key = runtimeKey(input);
    const activeRecord = this.records.get(key);
    if (activeRecord?.snapshot.generation === input.generation) {
      throw new RuntimeSessionError('generation_replaced', 'Runtime generation already has a registered session.');
    }
    const replacedCredentialId = this.currentCredentials.get(key);
    if (replacedCredentialId) {
      const previous = [...this.credentials.values()].find((entry) => entry.credentialId === replacedCredentialId);
      if (previous && previous.generation === input.generation &&
        (previous.environmentId !== input.environmentId || previous.branch !== input.branch ||
          previous.commit !== input.commit || previous.manifestDigest !== input.manifestDigest ||
          previous.runtimeVersion !== input.runtimeVersion)) {
        throw new RuntimeSessionError('generation_replaced', 'Runtime source binding changed.');
      }
      if (previous && previous.generation === input.generation && !previous.revokedAt) {
        throw new RuntimeSessionError('generation_replaced', 'Runtime generation already has an active session credential.');
      }
      if (previous) previous.revokedAt = now.toISOString();
    }
    const scope: StoredCredential = {
      ...input,
      credentialId,
      expiresAt,
      tokenHash: tokenHash(token)
    };
    this.credentials.set(scope.tokenHash, scope);
    this.operationCredentials.set(operationKey, scope);
    this.currentCredentials.set(key, credentialId);
    return {
      credential: publicCredential(scope, token),
      ...(replacedCredentialId ? { replacedCredentialId } : {})
    };
  }

  async authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const credential = this.credentials.get(tokenHash(token));
    if (!credential || credential.revokedAt || Date.parse(credential.expiresAt) <= this.clock.now().getTime() ||
      this.currentCredentials.get(runtimeKey(credential)) !== credential.credentialId) return null;
    return safeScope(credential);
  }

  async register(scope: RuntimeCredentialScope, sessionId: string, receivedAt: string, registration: WorkspaceRuntimeRegistration) {
    this.requireCurrent(scope);
    if (registration.workspaceId !== scope.workspaceId || registration.environmentId !== scope.environmentId ||
      registration.generation !== scope.generation || registration.branch !== scope.branch ||
      registration.commit !== scope.commit || registration.manifestDigest !== scope.manifestDigest ||
      registration.runtimeVersion !== scope.runtimeVersion) {
      throw new RuntimeSessionError('authentication_failed', 'Runtime registration identity changed.');
    }
    const key = runtimeKey(scope);
    const existing = this.records.get(key);
    if (existing && existing.snapshot.generation === scope.generation) {
      if (existing.snapshot.lifecycleState === 'stopped') {
        throw new RuntimeSessionError('generation_replaced', 'Stopped Runtime generation is terminal.');
      }
      if (registration.resumeAfterSequence > existing.snapshot.lastSequence ||
        existing.snapshot.branch !== registration.branch || existing.snapshot.commit !== registration.commit ||
        existing.snapshot.manifestDigest !== registration.manifestDigest ||
        existing.snapshot.runtimeVersion !== registration.runtimeVersion) {
        throw new RuntimeSessionError('sequence_conflict', 'Runtime resume evidence changed.');
      }
      existing.credentialId = scope.credentialId;
      const replacedSessionId = existing.snapshot.sessionId;
      existing.snapshot = {
        ...existing.snapshot,
        capabilities: [...scope.capabilities],
        connectionState: 'online',
        expiresAt: scope.expiresAt,
        lastEventAt: receivedAt,
        lastHeartbeatAt: receivedAt,
        sessionId
      };
      return { replacedSessionId, snapshot: cloneSnapshot(existing.snapshot) };
    }
    if (registration.resumeAfterSequence !== 0) {
      throw new RuntimeSessionError('sequence_conflict', 'A new Runtime generation cannot resume prior events.');
    }
    const snapshot: WorkspaceRuntimeSessionSnapshot = {
      branch: registration.branch,
      capabilities: [...scope.capabilities],
      commit: registration.commit,
      connectionState: 'online',
      devServers: [],
      environmentId: scope.environmentId,
      expiresAt: scope.expiresAt,
      generation: scope.generation,
      lastEventAt: receivedAt,
      lastHeartbeatAt: receivedAt,
      lastSequence: 0,
      lifecycleState: 'starting',
      manifestDigest: registration.manifestDigest,
      runtimeVersion: registration.runtimeVersion,
      schemaVersion: workspaceRuntimeSessionSchemaVersion,
      sessionId,
      workspaceId: scope.workspaceId
    };
    this.records.set(key, { credentialId: scope.credentialId, events: new Map(), snapshot });
    return {
      ...(existing ? { replacedCredentialId: existing.credentialId } : {}),
      snapshot: cloneSnapshot(snapshot)
    };
  }

  async append(scope: RuntimeCredentialScope, sessionId: string, receivedAt: string, event: WorkspaceRuntimeEvent) {
    this.requireCurrent(scope);
    const record = this.records.get(runtimeKey(scope));
    if (!record || record.credentialId !== scope.credentialId || record.snapshot.generation !== scope.generation ||
      record.snapshot.sessionId !== sessionId) {
      throw new RuntimeSessionError('generation_replaced', 'Runtime generation was replaced.');
    }
    if (record.snapshot.lifecycleState === 'stopped' || record.snapshot.connectionState !== 'online') {
      throw new RuntimeSessionError('generation_replaced', 'Stopped Runtime session is terminal.');
    }
    requireCapability(scope, event);
    if (Date.parse(event.observedAt) > Date.parse(receivedAt) + 5 * 60_000) {
      throw new RuntimeSessionError('invalid_message', 'Runtime event observation is too far in the future.');
    }
    const fingerprint = eventFingerprint(event);
    const prior = record.events.get(event.eventId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new RuntimeSessionError('replay_conflict', 'Runtime event ID was reused with different content.');
      }
      return { replayed: true, snapshot: cloneSnapshot(record.snapshot) };
    }
    if (event.sequence !== record.snapshot.lastSequence + 1) {
      throw new RuntimeSessionError('sequence_conflict', 'Runtime event sequence is not contiguous.');
    }
    const next = applyEvent(record.snapshot, receivedAt, event);
    record.events.set(event.eventId, { event, fingerprint });
    record.snapshot = next;
    return { replayed: false, snapshot: cloneSnapshot(next) };
  }

  async disconnect(scope: RuntimeCredentialScope, sessionId: string, checkedAt: string) {
    const record = this.records.get(runtimeKey(scope));
    if (record?.credentialId === scope.credentialId && record.snapshot.sessionId === sessionId &&
      record.snapshot.connectionState === 'online') {
      record.snapshot = { ...record.snapshot, connectionState: 'disconnected', lastEventAt: checkedAt };
    }
  }

  async list(ownerUserId: string) {
    return [...this.records.values()]
      .filter((record) => this.ownerFor(record.credentialId) === ownerUserId)
      .map((record) => cloneSnapshot(record.snapshot));
  }

  async markStale(staleBefore: string, checkedAt: string) {
    const cutoff = Date.parse(staleBefore);
    const changed: Array<{ ownerUserId: string; snapshot: WorkspaceRuntimeSessionSnapshot }> = [];
    for (const record of this.records.values()) {
      if (!['stopped', 'stale'].includes(record.snapshot.connectionState) &&
        Date.parse(record.snapshot.lastHeartbeatAt) < cutoff) {
        record.snapshot = { ...record.snapshot, connectionState: 'stale', lastEventAt: checkedAt };
        const ownerUserId = this.ownerFor(record.credentialId);
        if (!ownerUserId) throw new RuntimeSessionError('generation_replaced', 'Runtime owner is unavailable.');
        changed.push({ ownerUserId, snapshot: cloneSnapshot(record.snapshot) });
      }
    }
    return changed;
  }

  async revoke(ownerUserId: string, workspaceId: string, credentialId: string) {
    const credential = [...this.credentials.values()].find((entry) =>
      entry.ownerUserId === ownerUserId && entry.workspaceId === workspaceId && entry.credentialId === credentialId);
    if (credential) credential.revokedAt = this.clock.now().toISOString();
    const key = `${ownerUserId}\0${workspaceId}`;
    if (this.currentCredentials.get(key) === credentialId) this.currentCredentials.delete(key);
  }

  private requireCurrent(scope: RuntimeCredentialScope) {
    if (Date.parse(scope.expiresAt) <= this.clock.now().getTime()) {
      throw new RuntimeSessionError('credential_expired', 'Runtime credential expired.');
    }
    if (this.currentCredentials.get(runtimeKey(scope)) !== scope.credentialId) {
      throw new RuntimeSessionError('generation_replaced', 'Runtime generation was replaced.');
    }
  }

  private ownerFor(credentialId: string) {
    return [...this.credentials.values()].find((entry) => entry.credentialId === credentialId)?.ownerUserId;
  }
}

function applyEvent(snapshot: WorkspaceRuntimeSessionSnapshot, receivedAt: string, event: WorkspaceRuntimeEvent) {
  const next: WorkspaceRuntimeSessionSnapshot = {
    ...snapshot,
    connectionState: event.type === 'runtime.lifecycle' && event.state === 'stopped' ? 'stopped' : 'online',
    lastEventAt: receivedAt,
    lastSequence: event.sequence
  };
  if (event.type === 'runtime.heartbeat') next.lastHeartbeatAt = receivedAt;
  if (event.type === 'runtime.lifecycle') {
    if (!validLifecycleTransition(snapshot.lifecycleState, event.state)) {
      throw new RuntimeSessionError('sequence_conflict', 'Runtime lifecycle transition is invalid.');
    }
    next.lifecycleState = event.state;
  }
  if (event.type === 'runtime.dev-servers') next.devServers = event.devServers.map((entry) => ({ ...entry }));
  if (event.type === 'runtime.telemetry') next.telemetry = { cpuPercent: event.cpuPercent, memoryBytes: event.memoryBytes };
  if (event.type === 'runtime.log-pointer') next.logPointer = event.pointer;
  return next;
}

function publicCredential(scope: RuntimeCredentialScope, token: string): WorkspaceRuntimeCredential {
  return {
    capabilities: [...scope.capabilities], credentialId: scope.credentialId,
    environmentId: scope.environmentId, expiresAt: scope.expiresAt, generation: scope.generation,
    schemaVersion: workspaceRuntimeSessionSchemaVersion, token, workspaceId: scope.workspaceId
  };
}

function safeScope(scope: StoredCredential): RuntimeCredentialScope {
  return {
    branch: scope.branch, capabilities: [...scope.capabilities], commit: scope.commit,
    credentialId: scope.credentialId,
    environmentId: scope.environmentId, expiresAt: scope.expiresAt, generation: scope.generation,
    manifestDigest: scope.manifestDigest, ownerUserId: scope.ownerUserId,
    runtimeVersion: scope.runtimeVersion, workspaceId: scope.workspaceId
  };
}

function runtimeKey(input: { environmentId: string; ownerUserId: string; workspaceId: string }) {
  return `${input.ownerUserId}\0${input.workspaceId}`;
}

function sameIssue(left: StoredCredential, right: IssueRuntimeCredentialInput) {
  return left.workspaceId === right.workspaceId && left.environmentId === right.environmentId &&
    left.generation === right.generation && left.branch === right.branch && left.commit === right.commit &&
    left.manifestDigest === right.manifestDigest && left.runtimeVersion === right.runtimeVersion &&
    [...left.capabilities].sort().join('\0') === [...right.capabilities].sort().join('\0');
}

function requireCapability(scope: RuntimeCredentialScope, event: WorkspaceRuntimeEvent) {
  const capability = event.type === 'runtime.lifecycle' ? 'runtime.lifecycle'
    : event.type === 'runtime.heartbeat' ? 'runtime.heartbeat'
      : event.type === 'runtime.dev-servers' ? 'runtime.dev-servers'
        : event.type === 'runtime.telemetry' ? 'runtime.telemetry'
          : 'runtime.log-pointers';
  if (!scope.capabilities.includes(capability)) {
    throw new RuntimeSessionError('authentication_failed', `Runtime credential lacks ${capability}.`);
  }
}

function validLifecycleTransition(current: WorkspaceRuntimeSessionSnapshot['lifecycleState'], next: WorkspaceRuntimeSessionSnapshot['lifecycleState']) {
  const transitions: Record<
    WorkspaceRuntimeSessionSnapshot['lifecycleState'],
    readonly WorkspaceRuntimeSessionSnapshot['lifecycleState'][]
  > = {
    starting: ['running', 'failed', 'stopping'],
    running: ['suspended', 'stopping', 'failed'],
    suspended: ['running', 'stopping', 'failed'],
    stopping: ['stopped', 'failed'],
    stopped: [],
    failed: ['stopping', 'stopped']
  };
  return current === next || transitions[current].includes(next);
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function eventFingerprint(event: WorkspaceRuntimeEvent) {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function cloneSnapshot(snapshot: WorkspaceRuntimeSessionSnapshot): WorkspaceRuntimeSessionSnapshot {
  return structuredClone(snapshot);
}
