import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  projectHostdSchemaVersion,
  type ProjectHostdCredential,
  type ProjectHostdObservation,
  type ProjectHostdSnapshot
} from '../../src/shared/project-hostd-api';
import type {
  IssueProjectHostdCredentialInput,
  ProjectHostdCredentialScope,
  ProjectHostdStore
} from './contracts';
import { ProjectHostdError } from './contracts';
import { validateCredentialIssue } from './validation';

interface StoredCredential extends ProjectHostdCredentialScope {
  operationId: string;
  revokedAt?: string;
  tokenHash: string;
}

interface StoredObservation {
  fingerprint: string;
  receivedAt: string;
  sequence: number;
}

interface DeviceRecord {
  credentialId: string;
  observations: Map<string, StoredObservation>;
  snapshot: ProjectHostdSnapshot;
}

export class MemoryProjectHostdStore implements ProjectHostdStore {
  private readonly credentials = new Map<string, StoredCredential>();
  private readonly currentCredentials = new Map<string, string>();
  private readonly operations = new Map<string, StoredCredential>();
  private readonly records = new Map<string, DeviceRecord>();

  constructor(
    private readonly now = () => new Date(),
    private readonly createCredentialId = randomUUID,
    private readonly createToken = () => randomBytes(32).toString('base64url')
  ) {}

  async issue(input: IssueProjectHostdCredentialInput) {
    const operationKey = `${input.ownerUserId}\0${input.operationId}`;
    const priorOperation = this.operations.get(operationKey);
    if (priorOperation) {
      if (!sameIssue(priorOperation, input)) {
        throw new ProjectHostdError('replay_conflict', 'project-hostd credential request changed.');
      }
      throw new ProjectHostdError('operation_in_progress', 'project-hostd credential was already issued.');
    }
    const token = this.createToken();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').byteLength !== 32) {
      throw new Error('project-hostd credential must contain 32 random bytes.');
    }
    const credentialId = this.createCredentialId();
    const issuedAt = this.now();
    const expiresAt = new Date(
      issuedAt.getTime() + validateCredentialIssue(input) * 1_000
    ).toISOString();
    const key = deviceKey(input.ownerUserId, input.deviceId);
    const fixedTarget = [...this.credentials.values()].find((entry) =>
      entry.ownerUserId === input.ownerUserId && entry.deviceId === input.deviceId
    );
    if (fixedTarget && (fixedTarget.environmentId !== input.environmentId ||
      fixedTarget.hostId !== input.hostId)) {
      throw new ProjectHostdError('target_conflict', 'project-hostd device target cannot change.');
    }
    const replacedCredentialId = this.currentCredentials.get(key);
    if (replacedCredentialId) {
      const previous = [...this.credentials.values()].find((entry) =>
        entry.credentialId === replacedCredentialId
      );
      if (previous && (previous.environmentId !== input.environmentId ||
        previous.hostId !== input.hostId)) {
        throw new ProjectHostdError('target_conflict', 'project-hostd device target cannot change.');
      }
      if (previous) previous.revokedAt = issuedAt.toISOString();
    }
    const credential: StoredCredential = {
      credentialId,
      deviceId: input.deviceId,
      environmentId: input.environmentId,
      expiresAt,
      ...(input.hostId ? { hostId: input.hostId } : {}),
      operationId: input.operationId,
      ownerUserId: input.ownerUserId,
      tokenHash: hash(token)
    };
    this.credentials.set(credential.tokenHash, credential);
    this.currentCredentials.set(key, credentialId);
    this.operations.set(operationKey, credential);
    return publicCredential(credential, token);
  }

  async authenticate(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const credential = this.credentials.get(hash(token));
    if (!credential || credential.revokedAt || Date.parse(credential.expiresAt) <= this.now().getTime() ||
      this.currentCredentials.get(deviceKey(credential.ownerUserId, credential.deviceId)) !==
        credential.credentialId) return null;
    return safeScope(credential);
  }

  async append(
    scope: ProjectHostdCredentialScope,
    observation: ProjectHostdObservation,
    receivedAt: string
  ) {
    this.requireCurrent(scope);
    const key = deviceKey(scope.ownerUserId, scope.deviceId);
    const existing = this.records.get(key);
    const fingerprint = hash(JSON.stringify(observation));
    const prior = existing?.observations.get(observation.observationId) ??
      [...(existing?.observations.values() ?? [])].find((entry) =>
        entry.sequence === observation.sequence
      );
    if (prior) {
      if (prior.fingerprint !== fingerprint || prior.sequence !== observation.sequence) {
        throw new ProjectHostdError('replay_conflict', 'project-hostd observation replay changed.');
      }
      return { replayed: true, snapshot: clone(existing!.snapshot) };
    }
    if (observation.sequence !== (existing?.snapshot.sequence ?? 0) + 1) {
      throw new ProjectHostdError('sequence_conflict', 'project-hostd sequence is not contiguous.');
    }
    if (existing && existing.credentialId !== scope.credentialId) {
      existing.credentialId = scope.credentialId;
    }
    const snapshot = snapshotFrom(scope, observation, receivedAt);
    const record = existing ?? {
      credentialId: scope.credentialId,
      observations: new Map<string, StoredObservation>(),
      snapshot
    };
    record.observations.set(observation.observationId, {
      fingerprint,
      receivedAt,
      sequence: observation.sequence
    });
    record.snapshot = snapshot;
    this.records.set(key, record);
    return { replayed: false, snapshot: clone(snapshot) };
  }

  async list(ownerUserId: string) {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(`${ownerUserId}\0`))
      .map(([, record]) => clone(record.snapshot));
  }

  async markStale(staleBefore: string, checkedAt: string) {
    const cutoff = Date.parse(staleBefore);
    const stale: ProjectHostdSnapshot[] = [];
    for (const record of this.records.values()) {
      if (record.snapshot.connectionState === 'online' &&
        Date.parse(record.snapshot.lastSeenAt) < cutoff) {
        record.snapshot = {
          ...record.snapshot,
          connectionState: 'stale'
        };
        stale.push(clone(record.snapshot));
      }
    }
    return stale;
  }

  async pruneExpired(retainAfter: string) {
    let removed = 0;
    const cutoff = Date.parse(retainAfter);
    for (const record of this.records.values()) {
      for (const [id, observation] of record.observations) {
        if (observation.sequence < record.snapshot.sequence &&
          Date.parse(observation.receivedAt) < cutoff) {
          record.observations.delete(id);
          removed += 1;
        }
      }
    }
    return removed;
  }

  async replay(scope: ProjectHostdCredentialScope, observation: ProjectHostdObservation) {
    this.requireCurrent(scope);
    const existing = this.records.get(deviceKey(scope.ownerUserId, scope.deviceId));
    const prior = existing?.observations.get(observation.observationId) ??
      [...(existing?.observations.values() ?? [])].find((entry) => (
        entry.sequence === observation.sequence
      ));
    if (!prior) return null;
    const fingerprint = hash(JSON.stringify(observation));
    if (prior.fingerprint !== fingerprint || prior.sequence !== observation.sequence) {
      throw new ProjectHostdError('replay_conflict', 'project-hostd observation replay changed.');
    }
    return clone(existing!.snapshot);
  }

  async revoke(ownerUserId: string, deviceId: string, credentialId: string) {
    const credential = [...this.credentials.values()].find((entry) =>
      entry.ownerUserId === ownerUserId && entry.deviceId === deviceId &&
      entry.credentialId === credentialId
    );
    if (credential) credential.revokedAt = this.now().toISOString();
    const key = deviceKey(ownerUserId, deviceId);
    if (this.currentCredentials.get(key) === credentialId) this.currentCredentials.delete(key);
  }

  private requireCurrent(scope: ProjectHostdCredentialScope) {
    if (Date.parse(scope.expiresAt) <= this.now().getTime()) {
      throw new ProjectHostdError('credential_expired', 'project-hostd credential expired.');
    }
    if (this.currentCredentials.get(deviceKey(scope.ownerUserId, scope.deviceId)) !==
      scope.credentialId) {
      throw new ProjectHostdError('authentication_failed', 'project-hostd credential was replaced.');
    }
    const credential = [...this.credentials.values()].find((entry) =>
      entry.ownerUserId === scope.ownerUserId && entry.deviceId === scope.deviceId &&
      entry.credentialId === scope.credentialId
    );
    if (!credential || credential.revokedAt || credential.environmentId !== scope.environmentId ||
      credential.hostId !== scope.hostId || credential.expiresAt !== scope.expiresAt) {
      throw new ProjectHostdError('authentication_failed', 'project-hostd authority changed.');
    }
  }
}

function snapshotFrom(
  scope: ProjectHostdCredentialScope,
  observation: ProjectHostdObservation,
  receivedAt: string
): ProjectHostdSnapshot {
  return {
    connectionState: 'online', credentialId: scope.credentialId,
    deviceId: observation.deviceId, environmentId: observation.environmentId,
    health: observation.health, ...(observation.hostId ? { hostId: observation.hostId } : {}),
    hostdVersion: observation.hostdVersion, lastSeenAt: receivedAt,
    observedAt: observation.observedAt, partialMetrics: [...observation.partialMetrics],
    protocolVersion: observation.protocolVersion, resources: clone(observation.resources),
    runtimes: clone(observation.runtimes), schemaVersion: projectHostdSchemaVersion,
    sequence: observation.sequence, uptimeSeconds: observation.uptimeSeconds
  };
}

function publicCredential(credential: StoredCredential, token: string): ProjectHostdCredential {
  return {
    credentialId: credential.credentialId, deviceId: credential.deviceId,
    environmentId: credential.environmentId, expiresAt: credential.expiresAt,
    ...(credential.hostId ? { hostId: credential.hostId } : {}),
    schemaVersion: projectHostdSchemaVersion, token
  };
}

function safeScope(credential: StoredCredential): ProjectHostdCredentialScope {
  return {
    credentialId: credential.credentialId, deviceId: credential.deviceId,
    environmentId: credential.environmentId, expiresAt: credential.expiresAt,
    ...(credential.hostId ? { hostId: credential.hostId } : {}),
    ownerUserId: credential.ownerUserId
  };
}

function sameIssue(
  credential: StoredCredential,
  input: IssueProjectHostdCredentialInput
) {
  return credential.ownerUserId === input.ownerUserId && credential.deviceId === input.deviceId &&
    credential.environmentId === input.environmentId && credential.hostId === input.hostId;
}

function deviceKey(ownerUserId: string, deviceId: string) {
  return `${ownerUserId}\0${deviceId}`;
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}
