export const environmentLifecycleMigrationId = '0032_environment_lifecycle';

export const environmentLifecycleMigrationSql = `
  create table environment_provider_bindings (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    environment_id uuid,
    provider_kind text not null check (
      btrim(provider_kind) <> '' and char_length(provider_kind) <= 80
    ),
    provider_resource_id text not null check (
      btrim(provider_resource_id) <> '' and char_length(provider_resource_id) <= 256
    ),
    repository_full_name text not null check (
      btrim(repository_full_name) <> '' and char_length(repository_full_name) <= 256
    ),
    branch text not null check (btrim(branch) <> '' and char_length(branch) <= 256),
    task_number integer not null check (task_number > 0),
    lifecycle_state text not null check (
      lifecycle_state in (
        'missing', 'provisioning', 'stopped', 'starting', 'running', 'stopping',
        'deleting', 'deleted', 'failed', 'uncertain'
      )
    ),
    native_state text check (
      native_state is null or char_length(native_state) between 1 and 128
    ),
    observed_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (id, owner_user_id),
    unique (owner_user_id, provider_kind, provider_resource_id),
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id)
      on delete restrict
  );

  create unique index environment_provider_bindings_environment_unique
    on environment_provider_bindings (owner_user_id, environment_id)
    where environment_id is not null;

  create index environment_provider_bindings_task_idx
    on environment_provider_bindings (
      owner_user_id, provider_kind, repository_full_name, task_number, branch
    );

  create table environment_lifecycle_operations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    operation_id text not null check (
      btrim(operation_id) <> '' and char_length(operation_id) <= 128
    ),
    provider_kind text not null check (
      btrim(provider_kind) <> '' and char_length(provider_kind) <= 80
    ),
    scope_key text not null check (
      btrim(scope_key) <> '' and char_length(scope_key) <= 256
    ),
    action text not null check (action in ('provision', 'start', 'stop', 'delete')),
    binding_id uuid,
    environment_id uuid,
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    state text not null check (
      state in ('dispatching', 'completed', 'retryable', 'uncertain')
    ),
    dispatch_attempted boolean not null default false,
    result jsonb check (result is null or jsonb_typeof(result) = 'object'),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, operation_id),
    foreign key (binding_id, owner_user_id)
      references environment_provider_bindings (id, owner_user_id)
      on delete restrict,
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id)
      on delete restrict,
    check (action = 'provision' or environment_id is not null),
    check (state <> 'completed' or result is not null)
  );

  create unique index environment_lifecycle_one_unresolved_per_scope
    on environment_lifecycle_operations (owner_user_id, provider_kind, scope_key)
    where state = 'dispatching' or (state = 'uncertain' and dispatch_attempted);

  create index environment_lifecycle_operations_environment_time
    on environment_lifecycle_operations (owner_user_id, environment_id, created_at desc)
    where environment_id is not null;
`;
