export const computeEnvironmentIdentityResolutionMigrationId =
  '0031_compute_environment_identity_resolution';

export const computeEnvironmentIdentityResolutionMigrationSql = `
  alter table compute_environments
    add column identity_resolution text not null default 'resolved'
      check (identity_resolution in ('resolved', 'conflict'));
`;
