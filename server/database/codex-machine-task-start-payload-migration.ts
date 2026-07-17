export const codexMachineTaskStartPayloadMigrationId =
  '0023_codex_machine_task_start_payload';

export const codexMachineTaskStartPayloadMigrationSql = `
  alter table codex_machine_task_starts
    add column start_payload jsonb
      check (start_payload is null or jsonb_typeof(start_payload) = 'object');
`;
