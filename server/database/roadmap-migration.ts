export const roadmapMigrationId = '0024_roadmap_plans';

export const roadmapMigrationSql = `
  create table roadmap_plans (
    repository_id bigint primary key check (repository_id > 0),
    repository_full_name text not null check (btrim(repository_full_name) <> ''),
    revision bigint not null default 0 check (revision >= 0),
    plan jsonb not null default '{"goals":[],"items":[]}'::jsonb,
    plan_updated_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create index roadmap_plans_full_name_idx
    on roadmap_plans (lower(repository_full_name));

  create table roadmap_dependency_snapshots (
    repository_id bigint not null references roadmap_plans(repository_id) on delete cascade,
    principal_id text not null check (btrim(principal_id) <> ''),
    dependency_snapshot jsonb not null default '[]'::jsonb,
    dependency_checked_at timestamptz not null,
    updated_at timestamptz not null default now(),
    primary key (repository_id, principal_id)
  );
`;
