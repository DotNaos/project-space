import type { DatabaseQueryClient } from '../database/client';
import type { UpdateTaskExecutionHandoffInput } from './contracts';
import { executionColumns, type ExecutionRow } from './execution-store-records';

interface CurrentHandoffRow {
  handoff_id: string;
  handoff_revision: number | string;
}

export async function updatePostgresTaskExecutionHandoff(
  client: DatabaseQueryClient,
  input: UpdateTaskExecutionHandoffInput
) {
  const currentResult = await client.query<CurrentHandoffRow>(
    `select handoff_id, handoff_revision
       from task_executions
      where owner_user_id = $1 and id = $2::uuid and version = $3
        and state not in ('completed', 'failed', 'cancelled', 'archived')
      for update`,
    [input.ownerUserId, input.executionId, input.expectedVersion]
  );
  const current = currentResult.rows[0];
  if (!current || (current.handoff_id === input.handoff.id &&
      Number(current.handoff_revision) === input.handoff.revision)) return undefined;

  const updated = await client.query<ExecutionRow>(
    `update task_executions
        set handoff_id = $4::uuid, handoff_revision = $5,
            version = version + 1, updated_at = $6::timestamptz
      where owner_user_id = $1 and id = $2::uuid and version = $3
      returning ${executionColumns}`,
    [
      input.ownerUserId, input.executionId, input.expectedVersion,
      input.handoff.id, input.handoff.revision, input.updatedAt
    ]
  );
  if (!updated.rows[0]) return undefined;

  await client.query(
    `insert into task_execution_events (
       execution_id, owner_user_id, event_type, previous_handoff_id,
       previous_handoff_revision, handoff_id, handoff_revision, created_at
     ) values ($1::uuid, $2, 'handoff_updated', $3::uuid, $4, $5::uuid, $6, $7::timestamptz)`,
    [
      input.executionId, input.ownerUserId, current.handoff_id,
      Number(current.handoff_revision), input.handoff.id, input.handoff.revision,
      input.updatedAt
    ]
  );
  return updated.rows[0];
}
