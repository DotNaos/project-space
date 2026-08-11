import { randomUUID } from 'node:crypto';

import type {
  ConnectorRuntimeFailure,
  ConnectorRuntimeFingerprint,
  ConnectorRuntimeOperationName,
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState
} from '../src/shared/connector-runtime-api';
import type { DatabaseQueryClient } from './database/client';
import type { ConnectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';

export interface ConnectorRuntimeAuditInput {
  at: string;
  machineId?: string;
  operation?: ConnectorRuntimeOperationName;
  operationId?: string;
  outcome: 'accepted' | 'rejected';
  reason?: string;
  releaseId?: string;
  userId: string;
}

export interface CreateConnectorRuntimeOperationInput {
  deadlineAt: string;
  expectedBuildId?: string;
  expectedFingerprint?: ConnectorRuntimeFingerprint;
  expectedReleaseId?: string;
  machineId: string;
  operation: ConnectorRuntimeOperationName;
  previousFingerprint?: ConnectorRuntimeFingerprint;
  previousInstanceId?: string;
  requestedByUserId: string;
  requestedReleaseId?: string;
  target: ConnectorRuntimeReleaseTarget;
}

export interface CoalesceQueuedConnectorRuntimeUpdateInput {
  deadlineAt: string;
  expectedBuildId: string;
  expectedFingerprint: ConnectorRuntimeFingerprint;
  expectedReleaseId: string;
  fromExpectedFingerprint: ConnectorRuntimeFingerprint;
  fromExpectedReleaseId: string;
  fromTarget: ConnectorRuntimeReleaseTarget;
  id: string;
  preserveLastFailure?: boolean;
  previousFingerprint?: ConnectorRuntimeFingerprint;
  previousInstanceId?: string;
  requestedReleaseId: string;
  target: ConnectorRuntimeReleaseTarget;
  updatedAt: string;
}

export interface ClaimQueuedConnectorRuntimeOperationInput {
  deadlineAt: string;
  expectedBuildId?: string;
  expectedFingerprint?: ConnectorRuntimeFingerprint;
  expectedReleaseId?: string;
  id: string;
  requestedReleaseId?: string;
  startedAt: string;
  target: ConnectorRuntimeReleaseTarget;
  updatedAt: string;
}

export interface TransitionConnectorRuntimeOperationInput {
  deadlineAt?: string;
  expectedStates: ConnectorRuntimeOperationState[];
  finishedAt?: string;
  id: string;
  lastFailure?: ConnectorRuntimeFailure | null;
  startedAt?: string;
  state: ConnectorRuntimeOperationState;
  updatedAt: string;
}

export interface ConnectorRuntimeOperationStore {
  claimQueued(
    input: ClaimQueuedConnectorRuntimeOperationInput
  ): Promise<ConnectorRuntimeOperationRecord | null>;
  coalesceQueuedUpdate(
    input: CoalesceQueuedConnectorRuntimeUpdateInput
  ): Promise<ConnectorRuntimeOperationRecord | null>;
  createAccepted(
    input: CreateConnectorRuntimeOperationInput,
    audit: ConnectorRuntimeAuditInput,
    now: string
  ): Promise<ConnectorRuntimeOperationRecord>;
  latest(machineId: string): Promise<ConnectorRuntimeOperationRecord | null>;
  listActive(now?: string): Promise<ConnectorRuntimeOperationRecord[]>;
  recordRejection(audit: ConnectorRuntimeAuditInput): Promise<void>;
  transition(input: TransitionConnectorRuntimeOperationInput): Promise<ConnectorRuntimeOperationRecord | null>;
}

interface OperationRow {
  created_at: Date | string;
  deadline_at: Date | string;
  expected_build_id: string | null;
  expected_fingerprint: ConnectorRuntimeFingerprint | null;
  expected_release_id: string | null;
  finished_at: Date | string | null;
  id: string;
  last_failure: ConnectorRuntimeFailure | null;
  machine_id: string;
  operation: ConnectorRuntimeOperationName;
  previous_fingerprint: ConnectorRuntimeFingerprint | null;
  previous_instance_id: string | null;
  requested_by_user_id: string;
  started_at: Date | string | null;
  state: ConnectorRuntimeOperationState;
  updated_at: Date | string;
}

const terminalStates: ConnectorRuntimeOperationState[] = [
  'failed', 'recovery-required', 'rolled-back', 'succeeded'
];
const columns = `id, machine_id, requested_by_user_id, operation,
  expected_release_id, expected_build_id, state, previous_instance_id,
  previous_fingerprint, expected_fingerprint, last_failure, started_at,
  finished_at, deadline_at, created_at, updated_at`;

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function mapOperation(row: OperationRow): ConnectorRuntimeOperationRecord {
  return {
    createdAt: iso(row.created_at),
    deadlineAt: iso(row.deadline_at),
    expectedBuildId: row.expected_build_id ?? undefined,
    expectedFingerprint: row.expected_fingerprint ?? undefined,
    expectedReleaseId: row.expected_release_id ?? undefined,
    finishedAt: row.finished_at ? iso(row.finished_at) : undefined,
    id: row.id,
    lastFailure: row.last_failure ?? undefined,
    machineId: row.machine_id,
    operation: row.operation,
    previousFingerprint: row.previous_fingerprint ?? undefined,
    previousInstanceId: row.previous_instance_id ?? undefined,
    requestedByUserId: row.requested_by_user_id,
    startedAt: row.started_at ? iso(row.started_at) : undefined,
    state: row.state,
    updatedAt: iso(row.updated_at)
  };
}

function auditValues(audit: ConnectorRuntimeAuditInput) {
  return [
    audit.machineId ?? null,
    audit.userId,
    audit.operation ?? null,
    audit.operationId ?? null,
    audit.outcome,
    audit.reason ?? null,
    audit.releaseId ?? null,
    audit.at
  ];
}

export class PostgresConnectorRuntimeOperationStore implements ConnectorRuntimeOperationStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createId: () => string = randomUUID
  ) {}

  async claimQueued(input: ClaimQueuedConnectorRuntimeOperationInput) {
    const result = await this.client.query<OperationRow>(
      `update connector_runtime_operations set
         state = 'validating',
         last_failure = null,
         started_at = $7,
         deadline_at = $8,
         updated_at = $9
       where id = $1 and state = 'queued'
         and requested_release_id is not distinct from $2
         and expected_release_id is not distinct from $3
         and expected_build_id is not distinct from $4
         and expected_fingerprint is not distinct from $5
         and target = $6
       returning ${columns}`,
      [
        input.id, input.requestedReleaseId ?? null, input.expectedReleaseId ?? null,
        input.expectedBuildId ?? null, input.expectedFingerprint ?? null, input.target,
        input.startedAt, input.deadlineAt, input.updatedAt
      ]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async coalesceQueuedUpdate(input: CoalesceQueuedConnectorRuntimeUpdateInput) {
    const result = await this.client.query<OperationRow>(
      `update connector_runtime_operations set
         requested_release_id = $2,
         expected_release_id = $3,
         expected_build_id = $4,
         expected_fingerprint = $5,
         previous_fingerprint = $6,
         previous_instance_id = $7,
         target = $8,
         deadline_at = $9,
         last_failure = case when $10 then last_failure else null end,
         updated_at = $11
       where id = $1 and operation = 'update' and state = 'queued'
         and expected_release_id = $12
         and expected_fingerprint = $13
         and target = $14
       returning ${columns}`,
      [
        input.id, input.requestedReleaseId, input.expectedReleaseId,
        input.expectedBuildId, input.expectedFingerprint,
        input.previousFingerprint ?? null, input.previousInstanceId ?? null,
        input.target, input.deadlineAt, input.preserveLastFailure === true,
        input.updatedAt, input.fromExpectedReleaseId,
        input.fromExpectedFingerprint, input.fromTarget
      ]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async createAccepted(input: CreateConnectorRuntimeOperationInput, audit: ConnectorRuntimeAuditInput, now: string) {
    const id = this.createId();
    const result = await this.client.query<OperationRow>(
      `with inserted as (
         insert into connector_runtime_operations (
           id, machine_id, requested_by_user_id, operation, requested_release_id,
           expected_release_id, expected_build_id, previous_instance_id,
           previous_fingerprint, expected_fingerprint, target, state,
           deadline_at, created_at, updated_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$13,$13)
         returning ${columns}
       ), audited as (
         insert into connector_runtime_audit_events (
           action, machine_id, user_id, operation, operation_id, outcome, reason,
           release_id, created_at
         ) select 'connector-runtime.maintenance-request',$14,$15,$16,id,$17,$18,$19,$20
           from inserted
       ) select * from inserted`,
      [
        id, input.machineId, input.requestedByUserId, input.operation,
        input.requestedReleaseId ?? null, input.expectedReleaseId ?? null,
        input.expectedBuildId ?? null, input.previousInstanceId ?? null,
        input.previousFingerprint ?? null, input.expectedFingerprint ?? null,
        input.target, input.deadlineAt, now,
        audit.machineId ?? input.machineId, audit.userId, audit.operation ?? input.operation,
        audit.outcome, audit.reason ?? null, audit.releaseId ?? null, audit.at
      ]
    );
    if (!result.rows[0]) throw new Error('Connector runtime operation was not persisted.');
    return mapOperation(result.rows[0]);
  }

  async latest(machineId: string) {
    const result = await this.client.query<OperationRow>(
      `select ${columns} from connector_runtime_operations
        where machine_id = $1 order by created_at desc limit 1`,
      [machineId]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async listActive() {
    const result = await this.client.query<OperationRow>(
      `select ${columns} from connector_runtime_operations
        where state <> all($1::text[]) order by created_at`,
      [terminalStates]
    );
    return result.rows.map(mapOperation);
  }

  async recordRejection(audit: ConnectorRuntimeAuditInput) {
    await this.client.query(
      `insert into connector_runtime_audit_events (
         action, machine_id, user_id, operation, operation_id, outcome, reason,
         release_id, created_at
       ) values ('connector-runtime.maintenance-request',$1,$2,$3,$4,$5,$6,$7,$8)`,
      auditValues(audit)
    );
  }

  async transition(input: TransitionConnectorRuntimeOperationInput) {
    const updateFailure = input.lastFailure !== undefined;
    const result = await this.client.query<OperationRow>(
      `update connector_runtime_operations set
         state = $3,
         last_failure = case when $4 then $5 else last_failure end,
         started_at = coalesce($6, started_at),
         finished_at = coalesce($7, finished_at),
         deadline_at = coalesce($8, deadline_at),
         updated_at = $9
       where id = $1 and state = any($2::text[])
       returning ${columns}`,
      [
        input.id, input.expectedStates, input.state, updateFailure,
        input.lastFailure ?? null, input.startedAt ?? null,
        input.finishedAt ?? null, input.deadlineAt ?? null, input.updatedAt
      ]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }
}

interface MemoryOperationEntry {
  operation: ConnectorRuntimeOperationRecord;
  requestedReleaseId?: string;
  target: ConnectorRuntimeReleaseTarget;
}

export class MemoryConnectorRuntimeOperationStore implements ConnectorRuntimeOperationStore {
  private readonly operations = new Map<string, MemoryOperationEntry>();
  readonly audits: ConnectorRuntimeAuditInput[] = [];

  async claimQueued(input: ClaimQueuedConnectorRuntimeOperationInput) {
    const current = this.operations.get(input.id);
    if (!current || current.operation.state !== 'queued' ||
        current.requestedReleaseId !== input.requestedReleaseId ||
        current.operation.expectedReleaseId !== input.expectedReleaseId ||
        current.operation.expectedBuildId !== input.expectedBuildId ||
        JSON.stringify(current.operation.expectedFingerprint) !==
          JSON.stringify(input.expectedFingerprint) ||
        current.target !== input.target) return null;
    const operation: ConnectorRuntimeOperationRecord = {
      ...current.operation,
      deadlineAt: input.deadlineAt,
      lastFailure: undefined,
      startedAt: input.startedAt,
      state: 'validating',
      updatedAt: input.updatedAt
    };
    this.operations.set(operation.id, { ...current, operation });
    return structuredClone(operation);
  }

  async coalesceQueuedUpdate(input: CoalesceQueuedConnectorRuntimeUpdateInput) {
    const current = this.operations.get(input.id);
    if (!current || current.operation.operation !== 'update' ||
        current.operation.state !== 'queued' ||
        current.operation.expectedReleaseId !== input.fromExpectedReleaseId ||
        JSON.stringify(current.operation.expectedFingerprint) !==
          JSON.stringify(input.fromExpectedFingerprint) ||
        current.target !== input.fromTarget) {
      return null;
    }
    const operation: ConnectorRuntimeOperationRecord = {
      ...current.operation,
      deadlineAt: input.deadlineAt,
      expectedBuildId: input.expectedBuildId,
      expectedFingerprint: structuredClone(input.expectedFingerprint),
      expectedReleaseId: input.expectedReleaseId,
      lastFailure: input.preserveLastFailure ? current.operation.lastFailure : undefined,
      previousFingerprint: input.previousFingerprint
        ? structuredClone(input.previousFingerprint)
        : undefined,
      previousInstanceId: input.previousInstanceId,
      updatedAt: input.updatedAt
    };
    this.operations.set(operation.id, {
      operation,
      requestedReleaseId: input.requestedReleaseId,
      target: input.target
    });
    return structuredClone(operation);
  }

  async createAccepted(input: CreateConnectorRuntimeOperationInput, audit: ConnectorRuntimeAuditInput, now: string) {
    if ([...this.operations.values()].some(({ operation }) =>
      operation.machineId === input.machineId && !terminalStates.includes(operation.state)
    )) throw new Error('A connector runtime operation is already active.');
    const operation: ConnectorRuntimeOperationRecord = {
      createdAt: now,
      deadlineAt: input.deadlineAt,
      expectedBuildId: input.expectedBuildId,
      expectedFingerprint: input.expectedFingerprint,
      expectedReleaseId: input.expectedReleaseId,
      id: randomUUID(),
      machineId: input.machineId,
      operation: input.operation,
      previousFingerprint: input.previousFingerprint,
      previousInstanceId: input.previousInstanceId,
      requestedByUserId: input.requestedByUserId,
      state: 'queued',
      updatedAt: now
    };
    this.operations.set(operation.id, {
      operation,
      requestedReleaseId: input.requestedReleaseId,
      target: input.target
    });
    this.audits.push({ ...audit, operationId: operation.id });
    return structuredClone(operation);
  }

  async latest(machineId: string) {
    const value = [...this.operations.values()]
      .map(({ operation }) => operation)
      .filter((entry) => entry.machineId === machineId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return value ? structuredClone(value) : null;
  }

  async listActive() {
    return [...this.operations.values()].map(({ operation }) => operation)
      .filter((entry) => !terminalStates.includes(entry.state))
      .map((entry) => structuredClone(entry));
  }

  async recordRejection(audit: ConnectorRuntimeAuditInput) {
    this.audits.push(structuredClone(audit));
  }

  async transition(input: TransitionConnectorRuntimeOperationInput) {
    const current = this.operations.get(input.id);
    if (!current || !input.expectedStates.includes(current.operation.state)) return null;
    const next: ConnectorRuntimeOperationRecord = {
      ...current.operation,
      deadlineAt: input.deadlineAt ?? current.operation.deadlineAt,
      finishedAt: input.finishedAt ?? current.operation.finishedAt,
      lastFailure: input.lastFailure === null
        ? undefined
        : input.lastFailure ?? current.operation.lastFailure,
      startedAt: input.startedAt ?? current.operation.startedAt,
      state: input.state,
      updatedAt: input.updatedAt
    };
    this.operations.set(next.id, { ...current, operation: next });
    return structuredClone(next);
  }
}
