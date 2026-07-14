import { randomUUID } from 'node:crypto';

import type {
  ConnectorRuntimeFailure,
  ConnectorRuntimeOperationName,
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState
} from '../src/shared/project-space-api';
import type { DatabaseQueryClient } from './database/client';

export interface CreateConnectorRuntimeOperationInput {
  expectedBuildId?: string;
  expectedReleaseId?: string;
  machineId: string;
  operation: ConnectorRuntimeOperationName;
  previousInstanceId?: string;
  requestedByUserId: string;
  requestedReleaseId?: string;
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
  create(input: CreateConnectorRuntimeOperationInput, now: string): Promise<ConnectorRuntimeOperationRecord>;
  latest(machineId: string): Promise<ConnectorRuntimeOperationRecord | null>;
  transition(input: TransitionConnectorRuntimeOperationInput): Promise<ConnectorRuntimeOperationRecord | null>;
}

interface OperationRow {
  created_at: Date | string;
  expected_build_id: string | null;
  expected_release_id: string | null;
  finished_at: Date | string | null;
  id: string;
  last_failure: ConnectorRuntimeFailure | null;
  machine_id: string;
  operation: ConnectorRuntimeOperationName;
  previous_instance_id: string | null;
  requested_by_user_id: string;
  requested_release_id: string | null;
  started_at: Date | string | null;
  state: ConnectorRuntimeOperationState;
  updated_at: Date | string;
}

const columns = `id, machine_id, requested_by_user_id, operation,
  requested_release_id, expected_release_id, expected_build_id, state,
  previous_instance_id, last_failure, started_at, finished_at, created_at, updated_at`;

function iso(value: Date | string) {
  return new Date(value).toISOString();
}

function mapOperation(row: OperationRow): ConnectorRuntimeOperationRecord {
  return {
    createdAt: iso(row.created_at),
    expectedBuildId: row.expected_build_id ?? undefined,
    expectedReleaseId: row.expected_release_id ?? undefined,
    finishedAt: row.finished_at ? iso(row.finished_at) : undefined,
    id: row.id,
    lastFailure: row.last_failure ?? undefined,
    machineId: row.machine_id,
    operation: row.operation,
    previousInstanceId: row.previous_instance_id ?? undefined,
    requestedByUserId: row.requested_by_user_id,
    startedAt: row.started_at ? iso(row.started_at) : undefined,
    state: row.state,
    updatedAt: iso(row.updated_at)
  };
}

export class PostgresConnectorRuntimeOperationStore implements ConnectorRuntimeOperationStore {
  constructor(
    private readonly client: DatabaseQueryClient,
    private readonly createId: () => string = randomUUID
  ) {}

  async create(input: CreateConnectorRuntimeOperationInput, now: string) {
    const result = await this.client.query<OperationRow>(
      `insert into connector_runtime_operations (
         id, machine_id, requested_by_user_id, operation, requested_release_id,
         expected_release_id, expected_build_id, previous_instance_id, state, created_at, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9, $9)
       returning ${columns}`,
      [
        this.createId(),
        input.machineId,
        input.requestedByUserId,
        input.operation,
        input.requestedReleaseId ?? null,
        input.expectedReleaseId ?? null,
        input.expectedBuildId ?? null,
        input.previousInstanceId ?? null,
        now
      ]
    );
    if (!result.rows[0]) throw new Error('Connector runtime operation was not persisted.');
    return mapOperation(result.rows[0]);
  }

  async latest(machineId: string) {
    const result = await this.client.query<OperationRow>(
      `select ${columns}
         from connector_runtime_operations
        where machine_id = $1
        order by created_at desc
        limit 1`,
      [machineId]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }

  async transition(input: TransitionConnectorRuntimeOperationInput) {
    const result = await this.client.query<OperationRow>(
      `update connector_runtime_operations
          set state = $3,
              last_failure = $4,
              started_at = coalesce($5, started_at),
              finished_at = coalesce($6, finished_at),
              updated_at = $7
        where id = $1 and state = any($2::text[])
      returning ${columns}`,
      [
        input.id,
        input.expectedStates,
        input.state,
        input.lastFailure === undefined ? null : input.lastFailure,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        input.updatedAt
      ]
    );
    return result.rows[0] ? mapOperation(result.rows[0]) : null;
  }
}

export class MemoryConnectorRuntimeOperationStore implements ConnectorRuntimeOperationStore {
  private readonly operations = new Map<string, ConnectorRuntimeOperationRecord>();

  async create(input: CreateConnectorRuntimeOperationInput, now: string) {
    const active = [...this.operations.values()].find(
      (entry) => entry.machineId === input.machineId &&
        !['succeeded', 'failed', 'rolled-back'].includes(entry.state)
    );
    if (active) throw new Error('A connector runtime operation is already active.');
    const operation: ConnectorRuntimeOperationRecord = {
      createdAt: now,
      expectedBuildId: input.expectedBuildId,
      expectedReleaseId: input.expectedReleaseId,
      id: randomUUID(),
      machineId: input.machineId,
      operation: input.operation,
      previousInstanceId: input.previousInstanceId,
      requestedByUserId: input.requestedByUserId,
      state: 'queued',
      updatedAt: now
    };
    this.operations.set(operation.id, operation);
    return structuredClone(operation);
  }

  async latest(machineId: string) {
    const latest = [...this.operations.values()]
      .filter((entry) => entry.machineId === machineId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return latest ? structuredClone(latest) : null;
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
