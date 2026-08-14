export const infisicalCredentialReferencesMigrationId =
  '0054_infisical_credential_references';

export const infisicalCredentialReferencesMigrationSql = `
  update private_networks
     set credential_reference = null,
         enabled = false,
         approval_state = 'revoked',
         updated_at = now()
   where credential_reference like 'op://%';

  update access_routes
     set credential_reference = null,
         enabled = false,
         policy_state = 'blocked',
         availability = 'unavailable',
         updated_at = now()
   where credential_reference like 'op://%';

  alter table private_networks
    drop constraint if exists private_networks_credential_reference_check;
  alter table private_networks
    add constraint private_networks_credential_reference_check check (
      credential_reference is null or
      credential_reference ~ '^env://[A-Z_][A-Z0-9_]{0,127}$'
    );

  alter table access_routes
    drop constraint if exists access_routes_credential_reference_check;
  alter table access_routes
    add constraint access_routes_credential_reference_check check (
      credential_reference is null or
      credential_reference ~ '^env://[A-Z_][A-Z0-9_]{0,127}$'
    );
`;
