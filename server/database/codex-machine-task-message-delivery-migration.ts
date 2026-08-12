export const codexMachineTaskMessageDeliveryMigrationId =
  '0044_codex_machine_task_message_delivery';

export const codexMachineTaskMessageDeliveryMigrationSql = `
  alter table codex_machine_task_sends
    add column if not exists delivery text not null default 'new-turn',
    add column if not exists dispatch_delivery text not null default 'new-turn',
    add column if not exists expected_turn_id text,
    add column if not exists message text,
    add column if not exists request_fingerprint_sha256 text,
    add column if not exists dispatch_attempt integer not null default 0;

  alter table codex_machine_task_sends
    drop constraint if exists codex_machine_task_sends_state_check;

  alter table codex_machine_task_sends
    add constraint codex_machine_task_sends_state_check
      check (state in ('pending', 'queued', 'completed', 'uncertain')),
    add constraint codex_machine_task_sends_delivery_check
      check (delivery in ('auto', 'new-turn', 'queue', 'steer')),
    add constraint codex_machine_task_sends_dispatch_delivery_check
      check (dispatch_delivery in ('new-turn', 'steer')),
    add constraint codex_machine_task_sends_queued_payload_check
      check (state <> 'queued' or message is not null),
    add constraint codex_machine_task_sends_dispatch_attempt_check
      check (dispatch_attempt >= 0),
    add constraint codex_machine_task_sends_request_fingerprint_check
      check (request_fingerprint_sha256 is null or length(request_fingerprint_sha256) = 64);

  drop index if exists codex_machine_task_sends_one_unresolved_per_thread;
  create unique index codex_machine_task_sends_one_unresolved_per_thread
    on codex_machine_task_sends (owner_user_id, connector_id, thread_id)
    where state in ('pending', 'queued', 'uncertain');
`;
