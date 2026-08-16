export const tailscaleProviderConnectionRetirementMigrationId =
  '0056_tailscale_provider_connection_retirement';

export const tailscaleProviderConnectionRetirementMigrationSql = `
  with retired as (
    update tailscale_provider_connections
       set state = 'revoked',
           revision = revision + 1,
           credential_key_id = null,
           credential_ciphertext = null,
           credential_iv = null,
           credential_tag = null,
           revoked_at = coalesce(revoked_at, now()),
           updated_at = now()
     where state = 'active'
        or credential_key_id is not null
        or credential_ciphertext is not null
        or credential_iv is not null
        or credential_tag is not null
    returning connection_id, owner_user_id, revision
  )
  insert into tailscale_provider_connection_audits (
    connection_id, owner_user_id, actor_id, action, revision
  )
  select connection_id, owner_user_id,
         'project-space:migration:0056', 'revoked', revision
    from retired;
`;
