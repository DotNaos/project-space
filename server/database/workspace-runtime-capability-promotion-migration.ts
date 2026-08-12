export const workspaceRuntimeCapabilityPromotionMigrationId =
  '0045_workspace_runtime_capability_promotions';

export const workspaceRuntimeCapabilityPromotionMigrationSql = `
  alter table workspace_runtime_credentials
    add column requested_capabilities text[] not null default '{}'::text[] check (
      cardinality(requested_capabilities) <= 1 and
      requested_capabilities <@ array['runtime.codex.v1']::text[]
    );
`;
