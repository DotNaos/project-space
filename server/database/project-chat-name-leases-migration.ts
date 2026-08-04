export const projectChatNameLeasesMigrationId = '0027_project_chat_name_leases';

export const projectChatNameLeasesMigrationSql = `
  alter table project_chat_members
    add column name_lease_retired_at timestamptz;

  drop index project_chat_members_space_handle_unique;

  create unique index project_chat_members_space_handle_unique
    on project_chat_members (space_id, lower(handle))
    where name_lease_retired_at is null;

  update project_chat_name_claims
    set updated_at = date_trunc('milliseconds', now());

  create index project_chat_name_claims_lease_expiry_idx
    on project_chat_name_claims (space_id, updated_at, name_key);
`;
