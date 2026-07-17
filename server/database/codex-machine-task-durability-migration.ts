export const codexMachineTaskDurabilityMigrationId =
  '0022_codex_machine_task_durable_operations';

export const codexMachineTaskDurabilityMigrationSql = `
  alter table codex_machine_task_starts
    add column if not exists durable_operations boolean;

  update codex_machine_task_starts
     set durable_operations = false
   where durable_operations is null;

  alter table codex_machine_task_starts
    alter column durable_operations set not null;

  alter table codex_machine_task_sends
    add column if not exists durable_operations boolean;

  update codex_machine_task_sends
     set durable_operations = false
   where durable_operations is null;

  alter table codex_machine_task_sends
    alter column durable_operations set not null;
`;
