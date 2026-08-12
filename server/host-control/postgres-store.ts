import type { HostControlOperationResult } from '../../src/shared/host-control-api';
import type { DatabaseQueryClient } from '../database/client';
import type {
  HostControlActor,
  HostControlOperationStore
} from './contracts';

interface OperationRow {
  fingerprint_sha256: string;
  result: HostControlOperationResult | null;
}

export class PostgresHostControlOperationStore implements HostControlOperationStore {
  constructor(private readonly client: DatabaseQueryClient) {
    if (!client.transaction) throw new Error('Host control operations require transactions.');
  }

  reserve(input: {
    actor: HostControlActor; fingerprint: string; hostId: string; operationId: string;
  }) {
    return this.client.transaction!(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [
        `host-control:${input.actor.userId}:${input.operationId}`
      ]);
      const prior = await client.query<OperationRow>(
        `select fingerprint_sha256, result
           from host_control_operations
          where owner_user_id = $1 and operation_id = $2 for update`,
        [input.actor.userId, input.operationId]
      );
      if (prior.rows[0]) {
        if (prior.rows[0].fingerprint_sha256 !== input.fingerprint) return 'conflict' as const;
        return prior.rows[0].result ?? 'conflict' as const;
      }
      await client.query(
        `insert into host_control_operations (
           owner_user_id, operation_id, host_id, actor_type, caller_machine_id, fingerprint_sha256
         ) values ($1, $2, $3::uuid, $4, $5, $6)`,
        [input.actor.userId, input.operationId, input.hostId,
          input.actor.callerMachineId ? 'machine' : 'human',
          input.actor.callerMachineId ?? null, input.fingerprint]
      );
      return 'new' as const;
    });
  }

  async finish(input: {
    actor: HostControlActor; fingerprint: string; result: HostControlOperationResult;
  }) {
    const result = await this.client.query(
      `update host_control_operations
          set audit_id = $4::uuid, state = $5, result = $6::jsonb,
              completed_at = $7::timestamptz
        where owner_user_id = $1 and operation_id = $2 and
              fingerprint_sha256 = $3 and state = 'reserved'`,
      [input.actor.userId, input.result.operationId, input.fingerprint, input.result.auditId,
        input.result.state, JSON.stringify(input.result), input.result.completedAt]
    );
    if (result.rowCount !== 1) throw new Error('Host control audit reservation changed.');
  }
}
