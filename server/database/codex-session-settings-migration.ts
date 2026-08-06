export const codexSessionSettingsMigrationId = '0028_codex_session_settings_operations';

export const codexSessionSettingsMigrationSql = `
  alter table codex_session_operations
    drop constraint if exists codex_session_operations_operation_check;

  alter table codex_session_operations
    add constraint codex_session_operations_operation_check
    check (
      operation in (
        'approval', 'continue', 'input', 'interrupt', 'resume', 'settings', 'turn-start'
      )
    );
`;
