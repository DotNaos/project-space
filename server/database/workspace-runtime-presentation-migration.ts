export const workspaceRuntimePresentationMigrationId = '0052_workspace_runtime_presentation';

export const workspaceRuntimePresentationMigrationSql = `
  alter table workspace_runtime_generations
    add column presentation_repository text,
    add column presentation_task_number integer,
    add constraint workspace_runtime_presentation_check check (
      (presentation_repository is null and presentation_task_number is null) or
      (
        presentation_repository ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' and
        char_length(presentation_repository) <= 256 and
        (
          presentation_task_number is null or presentation_task_number > 0
        )
      )
    );
`;
