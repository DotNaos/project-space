import type {
  MachinePowerEvidence,
  MachinePowerOperationResult
} from '../../src/shared/machine-power-api';
import type { DatabaseQueryClient } from '../database/client';

export interface MachinePowerReservation {
  actorType: 'human' | 'machine';
  callerMachineId?: string;
  fingerprint: string;
  machineId: string;
  operationId: string;
  requestedState: 'on' | 'off';
  userId: string;
}

export interface MachinePowerOperationStore {
  reserve(input: MachinePowerReservation): Promise<
    | { kind: 'new' }
    | { kind: 'replayed'; result: MachinePowerOperationResult }
    | { kind: 'conflict' }
    | { kind: 'fenced' }
    | { kind: 'uncertain' }
  >;
  finish(
    input: MachinePowerReservation,
    result: MachinePowerOperationResult
  ): Promise<void>;
  markUncertain(
    input: MachinePowerReservation,
    dispatchAttempted?: boolean
  ): Promise<void>;
  reconcileOnline(
    userId: string,
    machineId: string,
    evidence: MachinePowerEvidence
  ): Promise<void>;
}

interface OperationRow {
  fingerprint_sha256: string;
  physical_machine_id: string;
  result: unknown;
  state: string;
}

export class PostgresMachinePowerOperationStore implements MachinePowerOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {}

  async reserve(input: MachinePowerReservation) {
    const run = async (client: DatabaseQueryClient) => {
      await client.query(
        'select pg_advisory_xact_lock(hashtext($1))',
        [`${input.userId}:${input.machineId}`]
      );
      const existing = await client.query<OperationRow>(
        `select physical_machine_id::text, fingerprint_sha256, state, result
           from machine_power_operations
          where owner_user_id = $1 and operation_id = $2
          for update`,
        [input.userId, input.operationId]
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.physical_machine_id !== input.machineId ||
            prior.fingerprint_sha256 !== input.fingerprint) {
          return { kind: 'conflict' } as const;
        }
        if (isOperationResult(prior.result)) {
          return { kind: 'replayed', result: prior.result } as const;
        }
        return { kind: 'uncertain' } as const;
      }
      await client.query(
        `update machine_power_operations
            set state = 'expired', updated_at = now()
          where owner_user_id = $1 and physical_machine_id = $2::uuid
            and (
              state = 'dispatching'
              or (state in ('accepted', 'uncertain') and dispatch_attempted)
            )
            and updated_at < now() - interval '5 minutes'`,
        [input.userId, input.machineId]
      );
      const active = await client.query<{ operation_id: string }>(
        `select operation_id
           from machine_power_operations
          where owner_user_id = $1 and physical_machine_id = $2::uuid
            and (
              state = 'dispatching'
              or (state in ('accepted', 'uncertain') and dispatch_attempted)
            )
          limit 1`,
        [input.userId, input.machineId]
      );
      if (active.rows.length > 0) return { kind: 'fenced' } as const;
      await client.query(
        `insert into machine_power_operations (
           owner_user_id, actor_type, caller_machine_id, operation_id,
           physical_machine_id, requested_state, fingerprint_sha256, state
         ) values ($1, $2, $3, $4, $5::uuid, $6, $7, 'dispatching')`,
        [
          input.userId, input.actorType, input.callerMachineId ?? null,
          input.operationId, input.machineId, input.requestedState, input.fingerprint
        ]
      );
      return { kind: 'new' } as const;
    };
    return this.client.transaction ? this.client.transaction(run) : run(this.client);
  }

  async finish(input: MachinePowerReservation, result: MachinePowerOperationResult) {
    const updated = await this.client.query<{ operation_id: string }>(
      `update machine_power_operations
          set state = $6, result = $7::jsonb, dispatch_attempted = $8,
              updated_at = now()
        where owner_user_id = $1 and operation_id = $2
          and physical_machine_id = $3::uuid and requested_state = $4
          and fingerprint_sha256 = $5 and state = 'dispatching'
        returning operation_id`,
      [
        input.userId, input.operationId, input.machineId, input.requestedState,
        input.fingerprint, result.state, JSON.stringify(result),
        result.dispatch.attempted
      ]
    );
    if (updated.rows.length !== 1) {
      throw new Error('Machine power operation reservation was not completed.');
    }
  }

  async markUncertain(input: MachinePowerReservation, dispatchAttempted = true) {
    await this.client.query(
      `update machine_power_operations
          set state = 'uncertain', dispatch_attempted = $5, updated_at = now()
        where owner_user_id = $1 and operation_id = $2
          and physical_machine_id = $3::uuid and fingerprint_sha256 = $4
          and state = 'dispatching'`,
      [
        input.userId, input.operationId, input.machineId, input.fingerprint,
        dispatchAttempted
      ]
    );
  }

  async reconcileOnline(
    userId: string,
    machineId: string,
    evidence: MachinePowerEvidence
  ) {
    await this.client.query(
      `update machine_power_operations
          set state = 'confirmed-online',
              dispatch_attempted = false,
              result = case
                when result is null then null
                else result || jsonb_build_object(
                  'state', 'confirmed-online',
                  'message', 'JetKVM confirms that the physical machine has power.',
                  'evidence', $3::jsonb
                )
              end,
              updated_at = now()
        where owner_user_id = $1 and physical_machine_id = $2::uuid
          and state in ('accepted', 'uncertain') and dispatch_attempted`,
      [userId, machineId, JSON.stringify(evidence)]
    );
  }
}

export class MemoryMachinePowerOperationStore implements MachinePowerOperationStore {
  private readonly records = new Map<string, {
    input: MachinePowerReservation;
    result?: MachinePowerOperationResult;
    uncertain?: boolean;
  }>();
  private readonly active = new Set<string>();

  async reserve(input: MachinePowerReservation) {
    const key = `${input.userId}:${input.operationId}`;
    const existing = this.records.get(key);
    if (existing) {
      if (existing.input.fingerprint !== input.fingerprint ||
          existing.input.machineId !== input.machineId) return { kind: 'conflict' } as const;
      if (existing.result) return { kind: 'replayed', result: existing.result } as const;
      return { kind: 'uncertain' } as const;
    }
    const machine = `${input.userId}:${input.machineId}`;
    if (this.active.has(machine)) return { kind: 'fenced' } as const;
    this.records.set(key, { input: structuredClone(input) });
    this.active.add(machine);
    return { kind: 'new' } as const;
  }

  async finish(input: MachinePowerReservation, result: MachinePowerOperationResult) {
    const record = this.records.get(`${input.userId}:${input.operationId}`);
    if (!record) throw new Error('Machine power operation reservation is missing.');
    record.result = structuredClone(result);
    const machine = `${input.userId}:${input.machineId}`;
    if (result.dispatch.attempted &&
        (result.state === 'accepted' || result.state === 'uncertain')) {
      this.active.add(machine);
    } else {
      this.active.delete(machine);
    }
  }

  async markUncertain(input: MachinePowerReservation, dispatchAttempted = true) {
    const record = this.records.get(`${input.userId}:${input.operationId}`);
    if (record) record.uncertain = true;
    const machine = `${input.userId}:${input.machineId}`;
    if (dispatchAttempted) this.active.add(machine);
    else this.active.delete(machine);
  }

  async reconcileOnline(
    userId: string,
    machineId: string,
    evidence: MachinePowerEvidence
  ) {
    for (const record of this.records.values()) {
      if (record.input.userId !== userId || record.input.machineId !== machineId ||
          !record.result?.dispatch.attempted ||
          (record.result.state !== 'accepted' && record.result.state !== 'uncertain')) continue;
      record.result = {
        ...record.result,
        evidence: structuredClone(evidence),
        message: 'JetKVM confirms that the physical machine has power.',
        state: 'confirmed-online'
      };
    }
    this.active.delete(`${userId}:${machineId}`);
  }
}

function isOperationResult(value: unknown): value is MachinePowerOperationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<MachinePowerOperationResult>;
  return result.apiVersion === 1 && typeof result.operationId === 'string' &&
    typeof result.state === 'string' && typeof result.message === 'string' &&
    Boolean(result.dispatch) &&
    typeof result.dispatch?.attempted === 'boolean' &&
    typeof result.dispatch?.brokerAcknowledged === 'boolean';
}
