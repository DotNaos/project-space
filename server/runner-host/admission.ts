import { createHash } from 'node:crypto';

import type { DatabaseQueryClient } from '../database/client';
import {
  RUNNER_HOST_ADMISSION_API_VERSION,
  runnerResourceDimensions,
  type RunnerHostAdmissionBlockedReason,
  type RunnerHostAdmissionPolicy,
  type RunnerHostAdmissionResult,
  type RunnerHostCapacityEvidence,
  type RunnerSandboxAbsenceProof,
  type RunnerSandboxAdmissionRequest,
  type RunnerSandboxReservation,
  type RunnerSandboxIdentity,
  type RunnerSandboxIsolationProfile,
  type RunnerResourceVector
} from '../../src/shared/runner-host-admission-api';

export interface RunnerHostAdmissionStore {
  list(hostId: string): Promise<RunnerSandboxReservation[]>;
  read(hostId: string, reservationId: string): Promise<RunnerSandboxReservation | undefined>;
  save(hostId: string, reservation: RunnerSandboxReservation): Promise<void>;
  withHostLock<T>(
    hostId: string,
    operation: (store: RunnerHostAdmissionStore) => Promise<T>
  ): Promise<T>;
  updateState(
    hostId: string,
    reservationId: string,
    state: RunnerSandboxReservation['state'],
    proof?: RunnerSandboxAbsenceProof
  ): Promise<RunnerSandboxReservation | undefined>;
}

export class MemoryRunnerHostAdmissionStore implements RunnerHostAdmissionStore {
  private readonly reservations = new Map<string, RunnerSandboxReservation>();
  private readonly locks = new Map<string, Promise<void>>();

  async list(hostId: string) {
    return [...this.reservations.values()]
      .filter(({ identity }) => identity.hostId === hostId)
      .map((reservation) => structuredClone(reservation));
  }

  async read(hostId: string, reservationId: string) {
    const reservation = this.reservations.get(reservationId);
    return reservation && reservation.identity.hostId === hostId ? structuredClone(reservation) : undefined;
  }

  async save(hostId: string, reservation: RunnerSandboxReservation) {
    if (!validIdentity(reservation.identity) || reservation.identity.hostId !== hostId ||
        reservation.hostGeneration !== reservation.identity.generation) {
      throw new Error('Runner sandbox reservation host binding is inconsistent.');
    }
    this.reservations.set(reservation.identity.reservationId, structuredClone(reservation));
  }

  async withHostLock<T>(
    hostId: string,
    operation: (store: RunnerHostAdmissionStore) => Promise<T>
  ): Promise<T> {
    const previous = this.locks.get(hostId) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    const lock = previous.then(() => current);
    this.locks.set(hostId, lock);
    await previous;
    try {
      return await operation(this);
    } finally {
      unlock();
      if (this.locks.get(hostId) === lock) this.locks.delete(hostId);
    }
  }

  async updateState(
    hostId: string,
    reservationId: string,
    state: RunnerSandboxReservation['state'],
    proof?: RunnerSandboxAbsenceProof
  ) {
    const reservation = this.reservations.get(reservationId);
    if (!reservation || reservation.identity.hostId !== hostId) return undefined;
    if (reservation.state === 'released') return structuredClone(reservation);
    if (state === 'released') {
      if (!validAbsenceProofIdentity(proof, reservation)) {
        throw new Error('Runner sandbox release requires positive absence evidence.');
      }
    }
    reservation.state = state;
    reservation.absenceProof = state === 'released' ? structuredClone(proof) : undefined;
    return structuredClone(reservation);
  }
}

interface RunnerSandboxReservationRow {
  absence_proof: RunnerSandboxAbsenceProof | null;
  created_at: Date | string;
  fingerprint: string;
  host_generation: string;
  idle_expires_at: Date | string;
  idle_timeout_seconds: number;
  identity: RunnerSandboxIdentity;
  isolation: RunnerSandboxIsolationProfile;
  lease_expires_at: Date | string;
  maximum_runtime_seconds: number;
  resources: RunnerResourceVector;
  runtime_expires_at: Date | string;
  state: RunnerSandboxReservation['state'];
}

const reservationColumns = `identity, isolation, resources, state, fingerprint, host_generation,
  absence_proof, created_at,
  idle_timeout_seconds, maximum_runtime_seconds, idle_expires_at, lease_expires_at,
  runtime_expires_at`;

export class PostgresRunnerHostAdmissionStore implements RunnerHostAdmissionStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async list(hostId: string) {
    const result = await this.client.query<RunnerSandboxReservationRow>(
      `select ${reservationColumns} from runner_sandbox_reservations
        where host_id = $1 and state <> 'released'
        order by created_at`,
      [hostId]
    );
    return result.rows.map(mapReservation);
  }

  async read(hostId: string, reservationId: string) {
    const result = await this.client.query<RunnerSandboxReservationRow>(
      `select ${reservationColumns} from runner_sandbox_reservations
        where host_id = $1 and reservation_id = $2`,
      [hostId, reservationId]
    );
    return result.rows[0] ? mapReservation(result.rows[0]) : undefined;
  }

  async save(hostId: string, reservation: RunnerSandboxReservation) {
    if (!validIdentity(reservation.identity) || reservation.identity.hostId !== hostId ||
        reservation.hostGeneration !== reservation.identity.generation) {
      throw new Error('Runner sandbox reservation host binding is inconsistent.');
    }
    await this.client.query(
      `insert into runner_sandbox_reservations (
         reservation_id, host_id, host_generation, identity, isolation, resources, state, fingerprint,
         created_at, idle_timeout_seconds, maximum_runtime_seconds,
         idle_expires_at, lease_expires_at, runtime_expires_at
       ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        reservation.identity.reservationId, hostId, reservation.hostGeneration,
        JSON.stringify(reservation.identity), JSON.stringify(reservation.isolation),
        JSON.stringify(reservation.resources), reservation.state, reservation.fingerprint,
        reservation.createdAt,
        reservation.idleTimeoutSeconds, reservation.maximumRuntimeSeconds,
        reservation.idleExpiresAt, reservation.leaseExpiresAt, reservation.runtimeExpiresAt
      ]
    );
  }

  async withHostLock<T>(
    hostId: string,
    operation: (store: RunnerHostAdmissionStore) => Promise<T>
  ): Promise<T> {
    if (!this.client.transaction) {
      throw new Error(
        'PostgreSQL runner admission store requires transaction support for host locking.'
      );
    }
    const run = async (client: DatabaseQueryClient): Promise<T> => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `runner-host-admission:${hostId}`
      ]);
      return operation(new PostgresRunnerHostAdmissionStore(client));
    };
    return this.client.transaction(run);
  }

  async updateState(
    hostId: string,
    reservationId: string,
    state: RunnerSandboxReservation['state'],
    proof?: RunnerSandboxAbsenceProof
  ) {
    const current = await this.read(hostId, reservationId);
    if (!current) return undefined;
    if (state === 'released' && !validAbsenceProofIdentity(proof, current)) {
      throw new Error('Runner sandbox release requires positive absence evidence.');
    }
    const result = await this.client.query<RunnerSandboxReservationRow>(
      `update runner_sandbox_reservations
          set state = $3, absence_proof = case when $3 = 'released' then $4::jsonb else absence_proof end
        where host_id = $1 and reservation_id = $2 and state <> 'released'
        returning ${reservationColumns}`,
      [hostId, reservationId, state, proof ? JSON.stringify(proof) : null]
    );
    if (result.rows[0]) return mapReservation(result.rows[0]);
    const replay = await this.read(hostId, reservationId);
    return replay?.state === 'released' ? replay : undefined;
  }
}

export class RunnerHostAdmissionService {
  constructor(
    private readonly store: RunnerHostAdmissionStore,
    private readonly policy: RunnerHostAdmissionPolicy,
    private readonly now: () => Date = () => new Date()
  ) {}

  async reserve(
    evidence: RunnerHostCapacityEvidence | undefined,
    request: RunnerSandboxAdmissionRequest
  ): Promise<RunnerHostAdmissionResult> {
    const admissionAt = this.now();
    const inputFailure = validateAdmissionInput(evidence, request, this.policy);
    if (inputFailure) return { kind: 'blocked', ...inputFailure };
    return this.store.withHostLock(request.identity.hostId, (store) => {
      return this.reserveLocked(store, evidence, request, admissionAt);
    });
  }

  private async reserveLocked(
    store: RunnerHostAdmissionStore,
    evidence: RunnerHostCapacityEvidence | undefined,
    request: RunnerSandboxAdmissionRequest,
    admissionAt: Date
  ): Promise<RunnerHostAdmissionResult> {
    const preFenceFailure = validateExistingReservations(
      await store.list(request.identity.hostId), request.identity.hostId, request.identity.generation,
      admissionAt, this.policy, false
    );
    if (preFenceFailure) return { kind: 'blocked', ...preFenceFailure };
    await this.fenceExpiredLocked(store, request.identity.hostId, admissionAt);
    const existing = await store.read(request.identity.hostId, request.identity.reservationId);
    const fingerprint = requestFingerprint(request);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          kind: 'conflict',
          message: 'The reservation identity is already bound to different sandbox input.',
          reason: 'identity_conflict'
        };
      }
      return { kind: 'replayed', reservation: existing };
    }

    const blocked = validateAdmission(
      evidence,
      request,
      this.policy,
      await store.list(request.identity.hostId),
      admissionAt
    );
    if (blocked) return { kind: 'blocked', ...blocked };

    const reservation: RunnerSandboxReservation = {
      ...structuredClone(request),
      createdAt: admissionAt.toISOString(),
      fingerprint,
      hostGeneration: evidence!.generation,
      idleExpiresAt: plusSeconds(admissionAt, request.idleTimeoutSeconds),
      leaseExpiresAt: plusSeconds(admissionAt, this.policy.leaseSeconds),
      runtimeExpiresAt: plusSeconds(admissionAt, request.maximumRuntimeSeconds),
      state: 'active'
    };
    await store.save(request.identity.hostId, reservation);
    return { kind: 'reserved', reservation };
  }

  async markUncertain(hostId: string, reservationId: string) {
    return this.store.withHostLock(hostId, (store) => (
      store.updateState(hostId, reservationId, 'uncertain')
    ));
  }

  async fenceExpired(hostId: string) {
    return this.store.withHostLock(hostId, (store) => (
      this.fenceExpiredLocked(store, hostId, this.now())
    ));
  }

  async release(hostId: string, reservationId: string, proof: RunnerSandboxAbsenceProof) {
    return this.store.withHostLock(hostId, async (store) => {
      const reservation = await store.read(hostId, reservationId);
      if (!reservation) return undefined;
      if (!validAbsenceProof(proof, reservation, this.policy, this.now())) {
        throw new Error('Runner sandbox release requires current exact absence evidence.');
      }
      return store.updateState(hostId, reservationId, 'released', proof);
    });
  }

  private async fenceExpiredLocked(
    store: RunnerHostAdmissionStore,
    hostId: string,
    now: Date
  ) {
    const fenced: RunnerSandboxReservation[] = [];
    for (const reservation of await store.list(hostId)) {
      if (validateExistingReservations(
        [reservation], hostId, reservation.hostGeneration, now, this.policy, false
      )) continue;
      if (reservation.state === 'active' && [
        reservation.idleExpiresAt,
        reservation.leaseExpiresAt,
        reservation.runtimeExpiresAt
      ].some((deadline) => Date.parse(deadline) <= now.getTime())) {
        const updated = await store.updateState(hostId, reservation.identity.reservationId, 'uncertain');
        if (updated) fenced.push(updated);
      }
    }
    return fenced;
  }
}

export function validateAdmission(
  evidence: RunnerHostCapacityEvidence | undefined,
  request: RunnerSandboxAdmissionRequest,
  policy: RunnerHostAdmissionPolicy,
  existing: readonly RunnerSandboxReservation[],
  now = new Date()
): { reason: RunnerHostAdmissionBlockedReason; message: string } | undefined {
  const inputFailure = validateAdmissionInput(evidence, request, policy);
  if (inputFailure) return inputFailure;
  if (evidence.cleanup.state !== 'proven') return blocked('cleanup_uncertain', 'Previous sandbox cleanup is uncertain; capacity remains fenced.');
  if (evidence.productionHealth !== 'healthy') return blocked('production_reservation_not_proven', 'Production health and reserved capacity are not proven.');
  if (!fresh(evidence, policy.evidenceMaxAgeSeconds, now)) return blocked('capacity_evidence_stale', 'VPS capacity evidence is stale or expires before admission.');
  const existingFailure = validateExistingReservations(
    existing, request.identity.hostId, request.identity.generation, now, policy
  );
  if (existingFailure) return existingFailure;
  if (evidence.capacity.maxConcurrentSandboxes < policy.maxConcurrentSandboxes) {
    return blocked('production_reservation_not_proven', 'The host evidence does not prove the configured sandbox pool.');
  }
  if (request.maximumRuntimeSeconds > policy.maximumRuntimeSeconds ||
      request.idleTimeoutSeconds <= 0 || request.idleTimeoutSeconds > request.maximumRuntimeSeconds ||
      policy.leaseSeconds <= 0 || policy.leaseSeconds > policy.maximumRuntimeSeconds) {
    return blocked('invalid_lease', 'Sandbox idle, runtime, and lease windows are outside the bounded policy.');
  }
  if (exceeds(request.resources, policy.sandboxMaximum) || exceeds(request.resources, policy.aggregateMaximum)) {
    return blocked('resource_limit', 'The sandbox resource profile exceeds the bounded VPS policy.');
  }
  if (!sameIsolation(request.isolation, policy.isolation)) {
    return blocked('resource_limit', 'The sandbox isolation profile is not the approved development boundary.');
  }
  const productionClaim = maxVector(evidence.capacity.productionUsage, policy.productionReservation);
  if (exceeds(productionClaim, evidence.capacity.total)) {
    return blocked('production_reservation_not_proven', 'The VPS cannot prove Production headroom for this reservation.');
  }

  const active = existing.filter(({ state }) => state !== 'released');
  if (active.some(({ state }) => state === 'uncertain')) return blocked('cleanup_uncertain', 'An uncertain sandbox operation still owns capacity.');
  const observedUsage = maxVector(evidence.capacity.sandboxUsage, sum(active.map(({ resources }) => resources)));
  const available = subtract(evidence.capacity.total, add(productionClaim, observedUsage));
  if (Math.max(active.length, evidence.capacity.sandboxCount) >= Math.min(policy.maxConcurrentSandboxes, evidence.capacity.maxConcurrentSandboxes)) {
    return blocked('concurrency_limit', 'The bounded concurrent sandbox limit has been reached.');
  }
  if (exceeds(request.resources, available) || exceeds(add(observedUsage, request.resources), policy.aggregateMaximum)) {
    return blocked('resource_limit', 'The sandbox would consume reserved Production or aggregate development capacity.');
  }
  return undefined;
}

function validateAdmissionInput(
  evidence: unknown,
  request: unknown,
  policy: unknown
): { reason: RunnerHostAdmissionBlockedReason; message: string } | undefined {
  if (!evidence) return blocked('capacity_evidence_missing', 'Fresh VPS capacity evidence is required before admission.');
  if (!isRecord(request)) return blocked('identity_invalid', 'The sandbox request is malformed.');
  if (!isRecord(policy)) return blocked('resource_limit', 'The admission policy is malformed.');
  if (!isRecord(evidence) || !isRecord(evidence.capacity) || !isRecord(evidence.cleanup)) {
    return blocked('capacity_evidence_invalid', 'The VPS capacity evidence is malformed.');
  }
  if (!validIdentity(request.identity)) return blocked('identity_invalid', 'The sandbox identity is malformed or incomplete.');
  if (!validIsolationProfile(request.isolation) || !validIsolationProfile(policy.isolation)) {
    return blocked('resource_limit', 'The sandbox isolation profile is malformed.');
  }
  if (evidence.apiVersion !== RUNNER_HOST_ADMISSION_API_VERSION) return blocked('capacity_evidence_invalid', 'The VPS capacity evidence API version is unsupported.');
  if (typeof evidence.hostId !== 'string' || typeof evidence.generation !== 'string') {
    return blocked('capacity_evidence_invalid', 'The VPS capacity evidence host binding is malformed.');
  }
  if (evidence.hostId !== request.identity.hostId || evidence.generation !== request.identity.generation) {
    return blocked('host_identity_mismatch', 'VPS capacity evidence is bound to a different host or generation.');
  }
  if (!validEvidenceScalars(evidence)) return blocked('capacity_evidence_invalid', 'The VPS capacity count is invalid.');
  if (!validPolicyResourceScalars(policy)) return blocked('resource_limit', 'The admission resource or proof policy scalar is invalid.');
  if (!validPolicyLeaseScalars(policy) || !validRequestDurationScalars(request)) {
    return blocked('invalid_lease', 'Sandbox idle, runtime, and lease windows are invalid.');
  }
  if (evidence.cleanup.state !== 'proven' && evidence.cleanup.state !== 'uncertain') {
    return blocked('capacity_evidence_invalid', 'The VPS cleanup evidence state is malformed.');
  }
  if (evidence.productionHealth !== 'healthy' && evidence.productionHealth !== 'unknown') {
    return blocked('capacity_evidence_invalid', 'The VPS Production health evidence is malformed.');
  }
  if (typeof evidence.observedAt !== 'string' || !Number.isFinite(Date.parse(evidence.observedAt)) ||
      typeof evidence.expiresAt !== 'string' || !Number.isFinite(Date.parse(evidence.expiresAt)) ||
      typeof evidence.cleanup.checkedAt !== 'string' || !Number.isFinite(Date.parse(evidence.cleanup.checkedAt))) {
    return blocked('capacity_evidence_invalid', 'The VPS capacity timestamps are malformed.');
  }
  if (!validVector(request.resources) || !validVector(policy.sandboxMaximum) ||
      !validVector(policy.aggregateMaximum) || !validVector(policy.productionReservation) ||
      !validVector(evidence.capacity.total) || !validVector(evidence.capacity.productionUsage) ||
      !validVector(evidence.capacity.sandboxUsage)) {
    return blocked('resource_limit', 'The VPS resource evidence or policy contains an invalid value.');
  }
  return undefined;
}

function fresh(evidence: RunnerHostCapacityEvidence, maxAgeSeconds: number, now: Date) {
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const cleanupCheckedAt = Date.parse(evidence.cleanup.checkedAt);
  const current = now.getTime();
  return Number.isFinite(observedAt) && Number.isFinite(expiresAt) && Number.isFinite(cleanupCheckedAt) &&
    observedAt <= current && cleanupCheckedAt <= current && expiresAt > current &&
    current - observedAt <= maxAgeSeconds * 1_000 && current - cleanupCheckedAt <= maxAgeSeconds * 1_000;
}

function requestFingerprint(request: RunnerSandboxAdmissionRequest) {
  return createHash('sha256').update(JSON.stringify(canonicalize(request))).digest('hex');
}

function plusSeconds(now: Date, seconds: number) {
  return new Date(now.getTime() + seconds * 1_000).toISOString();
}

function blocked(reason: RunnerHostAdmissionBlockedReason, message: string) {
  return { message, reason };
}

function sum(vectors: readonly RunnerResourceVector[]) {
  return vectors.reduce((total, vector) => add(total, vector), zero());
}

function zero(): RunnerResourceVector {
  return Object.fromEntries(runnerResourceDimensions.map((dimension) => [dimension, 0])) as RunnerResourceVector;
}

function add(left: RunnerResourceVector, right: RunnerResourceVector) {
  return Object.fromEntries(runnerResourceDimensions.map((dimension) => [
    dimension, left[dimension] + right[dimension]
  ])) as RunnerResourceVector;
}

function subtract(left: RunnerResourceVector, right: RunnerResourceVector) {
  return Object.fromEntries(runnerResourceDimensions.map((dimension) => [
    dimension, Math.max(0, left[dimension] - right[dimension])
  ])) as RunnerResourceVector;
}

function maxVector(left: RunnerResourceVector, right: RunnerResourceVector) {
  return Object.fromEntries(runnerResourceDimensions.map((dimension) => [
    dimension, Math.max(left[dimension], right[dimension])
  ])) as RunnerResourceVector;
}

function exceeds(actual: RunnerResourceVector, maximum: RunnerResourceVector) {
  return runnerResourceDimensions.some((dimension) => actual[dimension] > maximum[dimension]);
}

function validVector(vector: unknown): vector is RunnerResourceVector {
  if (!vector || typeof vector !== 'object') return false;
  return runnerResourceDimensions.every((dimension) =>
    Number.isSafeInteger((vector as Record<string, unknown>)[dimension]) &&
    ((vector as Record<string, unknown>)[dimension] as number) >= 0
  );
}

function validateExistingReservations(
  existing: readonly RunnerSandboxReservation[],
  hostId: string,
  generation: string,
  now: Date,
  policy: RunnerHostAdmissionPolicy,
  rejectUncertain = true
) {
  if (!Array.isArray(existing)) {
    return blocked('capacity_evidence_invalid', 'Durable sandbox reservations are not a valid collection.');
  }
  if (!validPolicyLeaseScalars(policy) || !validIsolationProfile(policy.isolation)) {
    return blocked('resource_limit', 'The admission lease or isolation policy is invalid.');
  }
  for (const reservation of existing) {
    if (!reservation || typeof reservation !== 'object') {
      return blocked('capacity_evidence_invalid', 'A durable sandbox reservation is malformed.');
    }
    if (reservation.state === 'released') continue;
    if (reservation.state !== 'active' && reservation.state !== 'uncertain') {
      return blocked('capacity_evidence_invalid', 'A durable sandbox reservation has an invalid state.');
    }
    if (!validIdentity(reservation.identity) || reservation.identity.hostId !== hostId ||
        reservation.identity.generation !== generation || reservation.hostGeneration !== generation ||
        reservation.hostGeneration !== reservation.identity.generation) {
      return blocked('identity_invalid', 'A durable sandbox reservation is bound to a different identity, host, or generation.');
    }
    if (!validIsolationProfile(reservation.isolation) || !sameIsolation(reservation.isolation, policy.isolation)) {
      return blocked('resource_limit', 'A durable sandbox reservation uses an unapproved isolation profile.');
    }
    if (!validVector(reservation.resources) ||
        !positiveSafeInteger(reservation.idleTimeoutSeconds) ||
        !positiveSafeInteger(reservation.maximumRuntimeSeconds) ||
        typeof reservation.fingerprint !== 'string' ||
        !/^[0-9a-f]{64}$/.test(reservation.fingerprint) ||
        reservation.fingerprint !== requestFingerprint({
          idleTimeoutSeconds: reservation.idleTimeoutSeconds,
          identity: reservation.identity,
          isolation: reservation.isolation,
          maximumRuntimeSeconds: reservation.maximumRuntimeSeconds,
          resources: reservation.resources
        })) {
      return blocked('capacity_evidence_invalid', 'A durable sandbox reservation contains an invalid resource or scalar.');
    }
    const createdAt = parseStoredTimestamp(reservation.createdAt);
    const idleExpiresAt = parseStoredTimestamp(reservation.idleExpiresAt);
    const leaseExpiresAt = parseStoredTimestamp(reservation.leaseExpiresAt);
    const runtimeExpiresAt = parseStoredTimestamp(reservation.runtimeExpiresAt);
    if (createdAt === undefined || idleExpiresAt === undefined || leaseExpiresAt === undefined ||
        runtimeExpiresAt === undefined || createdAt > now.getTime() ||
        idleExpiresAt <= createdAt || leaseExpiresAt <= createdAt || runtimeExpiresAt <= createdAt ||
        reservation.idleTimeoutSeconds > reservation.maximumRuntimeSeconds ||
        reservation.maximumRuntimeSeconds > policy.maximumRuntimeSeconds ||
        idleExpiresAt !== createdAt + reservation.idleTimeoutSeconds * 1_000 ||
        leaseExpiresAt !== createdAt + policy.leaseSeconds * 1_000 ||
        runtimeExpiresAt !== createdAt + reservation.maximumRuntimeSeconds * 1_000) {
      return blocked('capacity_evidence_invalid', 'A durable sandbox reservation contains incoherent timestamps.');
    }
    if (rejectUncertain && reservation.state === 'uncertain') {
      return blocked('cleanup_uncertain', 'An uncertain sandbox operation still owns capacity.');
    }
  }
  return undefined;
}

function parseStoredTimestamp(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validEvidenceScalars(evidence: unknown) {
  return isRecord(evidence) && isRecord(evidence.capacity) &&
    positiveOrZeroSafeInteger(evidence.capacity.maxConcurrentSandboxes) &&
    positiveOrZeroSafeInteger(evidence.capacity.sandboxCount);
}

function validPolicyResourceScalars(policy: unknown) {
  return isRecord(policy) &&
    positiveOrZeroSafeInteger(policy.absenceProofClockSkewSeconds) &&
    positiveSafeInteger(policy.absenceProofMaxAgeSeconds) &&
    positiveSafeInteger(policy.evidenceMaxAgeSeconds) &&
    positiveSafeInteger(policy.maxConcurrentSandboxes);
}

function validPolicyLeaseScalars(policy: unknown) {
  return isRecord(policy) &&
    positiveSafeInteger(policy.leaseSeconds) &&
    positiveSafeInteger(policy.maximumRuntimeSeconds) &&
    policy.leaseSeconds <= policy.maximumRuntimeSeconds;
}

function validRequestDurationScalars(request: unknown) {
  return isRecord(request) &&
    positiveSafeInteger(request.idleTimeoutSeconds) &&
    positiveSafeInteger(request.maximumRuntimeSeconds);
}

function positiveOrZeroSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validAbsenceProof(
  proof: RunnerSandboxAbsenceProof | undefined,
  reservation: RunnerSandboxReservation,
  policy: RunnerHostAdmissionPolicy,
  now: Date
) {
  if (!proof || !validAbsenceProofIdentity(proof, reservation)) return false;
  const checkedAt = Date.parse(proof.checkedAt);
  const current = now.getTime();
  return Number.isFinite(checkedAt) &&
    checkedAt <= current + policy.absenceProofClockSkewSeconds * 1_000 &&
    current - checkedAt <= policy.absenceProofMaxAgeSeconds * 1_000;
}

function validAbsenceProofIdentity(
  proof: RunnerSandboxAbsenceProof | undefined,
  reservation: RunnerSandboxReservation
) {
  return proof?.resourcesAbsent === true &&
    validIdentity(proof.identity) &&
    sameIdentity(proof.identity, reservation.identity) &&
    reservation.hostGeneration === reservation.identity.generation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validIdentity(identity: unknown): identity is RunnerSandboxIdentity {
  if (!identity || typeof identity !== 'object') return false;
  const candidate = identity as Record<string, unknown>;
  const expectedKeys = [
    'baseSha', 'branch', 'codexTaskId', 'generation', 'hostId', 'issueNumber',
    'operationId', 'ownerUserId', 'projectManagerTaskId', 'repositoryId',
    'reservationId', 'taskId', 'workspaceId'
  ].sort();
  const actualKeys = Object.keys(candidate).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    typeof candidate.baseSha === 'string' && /^[0-9a-f]{40}$/.test(candidate.baseSha) &&
    positiveSafeInteger(candidate.issueNumber) &&
    [
      candidate.branch, candidate.codexTaskId, candidate.generation, candidate.hostId,
      candidate.operationId, candidate.ownerUserId, candidate.projectManagerTaskId,
      candidate.repositoryId, candidate.reservationId, candidate.taskId, candidate.workspaceId
    ].every(validIdentityText);
}

function validIdentityText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function sameIdentity(left: RunnerSandboxIdentity, right: RunnerSandboxIdentity) {
  return left.baseSha === right.baseSha && left.branch === right.branch &&
    left.codexTaskId === right.codexTaskId && left.generation === right.generation &&
    left.hostId === right.hostId && left.issueNumber === right.issueNumber &&
    left.operationId === right.operationId && left.ownerUserId === right.ownerUserId &&
    left.projectManagerTaskId === right.projectManagerTaskId && left.repositoryId === right.repositoryId &&
    left.reservationId === right.reservationId && left.taskId === right.taskId &&
    left.workspaceId === right.workspaceId;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function sameIsolation(
  actual: RunnerSandboxIsolationProfile,
  expected: RunnerSandboxIsolationProfile
) {
  return actual.dockerSocket === expected.dockerSocket &&
    actual.hostNetwork === expected.hostNetwork &&
    actual.productionFilesystem === expected.productionFilesystem &&
    actual.productionDatabase === expected.productionDatabase &&
    actual.deploymentCredentials === expected.deploymentCredentials &&
    actual.crossSandboxWritableVolumes === expected.crossSandboxWritableVolumes &&
    actual.egress === expected.egress &&
    actual.sharedCaches === expected.sharedCaches;
}

function validIsolationProfile(value: unknown): value is RunnerSandboxIsolationProfile {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    'crossSandboxWritableVolumes', 'deploymentCredentials', 'dockerSocket', 'egress',
    'hostNetwork', 'productionDatabase', 'productionFilesystem', 'sharedCaches'
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) return false;
  return value.crossSandboxWritableVolumes === 'denied' &&
    value.deploymentCredentials === 'denied' &&
    value.dockerSocket === 'denied' &&
    value.egress === 'development' &&
    value.hostNetwork === 'denied' &&
    value.productionDatabase === 'denied' &&
    value.productionFilesystem === 'denied' &&
    value.sharedCaches === 'immutable-only';
}

function mapReservation(row: RunnerSandboxReservationRow): RunnerSandboxReservation {
  return {
    createdAt: new Date(row.created_at).toISOString(),
    fingerprint: row.fingerprint,
    hostGeneration: row.host_generation,
    idleExpiresAt: new Date(row.idle_expires_at).toISOString(),
    idleTimeoutSeconds: row.idle_timeout_seconds,
    identity: row.identity,
    isolation: row.isolation,
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    maximumRuntimeSeconds: row.maximum_runtime_seconds,
    resources: row.resources,
    runtimeExpiresAt: new Date(row.runtime_expires_at).toISOString(),
    state: row.state,
    ...(row.absence_proof ? { absenceProof: row.absence_proof } : {})
  };
}
