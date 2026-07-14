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

export interface TransitionConnectorRuntimeOperationInput {
  expectedStates: ConnectorRuntimeOperationState[];
  finishedAt?: string;
  id: string;
  lastFailure?: ConnectorRuntimeFailure | null;
  startedAt?: string;
  state: ConnectorRuntimeOperationState;
  updatedAt: string;
}

export interface ConnectorRuntimeOperationStore {
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
         updated_at = $8
       where id = $1 and state = any($2::text[])
       returning ${columns}`,
      [
        input.id, input.expectedStates, input.state, updateFailure,
        input.lastFailure ?? null, input.startedAt ?? null,
        input.finishedAt ?? null, input.updatedAt
      ]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }
}

export class MemoryConnectorRuntimeOperationStore implements ConnectorRuntimeOperationStore {
  private readonly operations = new Map<string, ConnectorRuntimeOperationRecord>();
  readonly audits: ConnectorRuntimeAuditInput[] = [];

  async createAccepted(input: CreateConnectorRuntimeOperationInput, audit: ConnectorRuntimeAuditInput, now: string) {
    if ([...this.operations.values()].some((entry) =>
      entry.machineId === input.machineId && !terminalStates.includes(entry.state)
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
    this.operations.set(operation.id, operation);
    this.audits.push({ ...audit, operationId: operation.id });
    return structuredClone(operation);
  }

  async latest(machineId: string) {
    const value = [...this.operations.values()].filter((entry) => entry.machineId === machineId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return value ? structuredClone(value) : null;
  }

  async listActive() {
    return [...this.operations.values()].filter((entry) => !terminalStates.includes(entry.state))
      .map((entry) => structuredClone(entry));
  }

  async recordRejection(audit: ConnectorRuntimeAuditInput) {
    this.audits.push(structuredClone(audit));
  }

  async transition(input: TransitionConnectorRuntimeOperationInput) {
    const current = this.operations.get(input.id);
    if (!current || !input.expectedStates.includes(current.state)) return null;
    const next: ConnectorRuntimeOperationRecord = {
      ...current,
      finishedAt: input.finishedAt ?? current.finishedAt,
      lastFailure: input.lastFailure === null ? undefined : input.lastFailure ?? current.lastFailure,
      startedAt: input.startedAt ?? current.startedAt,
      state: input.state,
      updatedAt: input.updatedAt
    };
    this.operations.set(next.id, next);
    return structuredClone(next);
  }
}
