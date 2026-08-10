export const codexMachineTaskSendQueueMigrationId = '0038_codex_machine_task_send_queue';

export const codexMachineTaskSendQueueMigrationSql = `
  alter table codex_machine_task_sends
    add column request_payload jsonb check (
      request_payload is null or jsonb_typeof(request_payload) = 'object'
    ),
    add column dispatch_attempt integer not null default 0
      check (dispatch_attempt >= 0);

  update codex_machine_task_sends
     set state = 'uncertain', updated_at = now()
   where state = 'pending';

  drop index if exists codex_machine_task_sends_one_unresolved_per_thread;

  alter table codex_machine_task_sends
    drop constraint codex_machine_task_sends_state_check;

  alter table codex_machine_task_sends
    add constraint codex_machine_task_sends_state_check
    check (state in ('pending', 'queued', 'completed', 'uncertain'));

  alter table codex_machine_task_sends
    add constraint codex_machine_task_sends_active_request_check
    check (state not in ('pending', 'queued') or request_payload is not null);

  create unique index codex_machine_task_sends_one_pending_per_thread
    on codex_machine_task_sends (owner_user_id, connector_id, thread_id)
    where state = 'pending';

  create index codex_machine_task_sends_queued_fifo_idx
    on codex_machine_task_sends (
      owner_user_id, connector_id, thread_id, created_at, operation_id
    ) where state = 'queued';
`;
