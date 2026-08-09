export const taskDeliveryMigrationId = "0037_task_delivery";

export const taskDeliveryMigrationSql = `
  alter table execution_operations
    add column scope_key text check (
      scope_key is null or (
        btrim(scope_key) <> '' and char_length(scope_key) <= 512
      )
    );

  create unique index execution_operations_one_unresolved_scope
    on execution_operations (owner_user_id, scope_key)
    where scope_key is not null and state in ('dispatched', 'confirmed', 'uncertain');

  create unique index task_executions_delivery_target_identity
    on task_executions (id, owner_user_id, repository_id, task_id, branch);

  create table task_deliveries (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    origin_execution_id uuid not null,
    provider_kind text not null check (
      btrim(provider_kind) <> '' and char_length(provider_kind) <= 80
    ),
    repository_id text not null check (
      btrim(repository_id) <> '' and char_length(repository_id) <= 512
    ),
    task_id text not null check (btrim(task_id) <> '' and char_length(task_id) <= 512),
    branch text not null check (btrim(branch) <> '' and char_length(branch) <= 256),
    pull_request_number integer check (pull_request_number > 0),
    completion_policy text not null check (
      completion_policy in ('execution_verified', 'merged', 'deployed_healthy')
    ),
    deployment_environment text check (
      deployment_environment is null or (
        btrim(deployment_environment) <> '' and char_length(deployment_environment) <= 80
      )
    ),
    version bigint not null check (version > 0),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    primary key (id, owner_user_id),
    unique (owner_user_id, provider_kind, repository_id, task_id, branch),
    foreign key (
      origin_execution_id, owner_user_id, repository_id, task_id, branch
    ) references task_executions (id, owner_user_id, repository_id, task_id, branch)
      on delete restrict,
    check (
      (completion_policy = 'deployed_healthy') = (deployment_environment is not null)
    )
  );

  create unique index task_deliveries_provider_pull_request_unique
    on task_deliveries (
      owner_user_id, provider_kind, repository_id, pull_request_number
    ) where pull_request_number is not null;

  create table task_delivery_evidence (
    delivery_id uuid not null,
    owner_user_id text not null,
    evidence_revision bigint not null check (evidence_revision > 0),
    observing_execution_id uuid not null,
    source_commit_sha text not null check (source_commit_sha ~ '^[0-9a-f]{40}$'),
    task_state text not null check (task_state in ('open', 'completed')),
    pull_request_number integer check (pull_request_number > 0),
    pull_request_base_branch text check (
      pull_request_base_branch is null or (
        btrim(pull_request_base_branch) <> '' and char_length(pull_request_base_branch) <= 256
      )
    ),
    pull_request_head_sha text check (pull_request_head_sha ~ '^[0-9a-f]{40}$'),
    pull_request_state text check (pull_request_state in ('open', 'closed', 'merged')),
    pull_request_draft boolean,
    checks_state text not null check (
      checks_state in ('unavailable', 'pending', 'passing', 'failing')
    ),
    checks_fingerprint_sha256 text check (
      checks_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    ),
    checks_commit_sha text not null check (checks_commit_sha ~ '^[0-9a-f]{40}$'),
    required_checks jsonb not null check (
      jsonb_typeof(required_checks) = 'array' and
      octet_length(required_checks::text) <= 32768
    ),
    review_state text not null check (
      review_state in ('approved', 'changes_requested', 'required', 'unavailable')
    ),
    review_commit_sha text check (review_commit_sha ~ '^[0-9a-f]{40}$'),
    review_fingerprint_sha256 text check (review_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    review_request_fingerprint_sha256 text check (
      review_request_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    ),
    review_unresolved_threads integer check (review_unresolved_threads between 0 and 1000),
    review_checked_at timestamptz,
    preview_state text not null check (
      preview_state in ('unavailable', 'pending', 'ready', 'failed', 'superseded')
    ),
    preview_head_sha text check (preview_head_sha ~ '^[0-9a-f]{40}$'),
    merge_commit_sha text check (merge_commit_sha ~ '^[0-9a-f]{40}$'),
    deployment_environment text check (
      deployment_environment is null or (
        btrim(deployment_environment) <> '' and char_length(deployment_environment) <= 80
      )
    ),
    deployed_commit_sha text check (deployed_commit_sha ~ '^[0-9a-f]{40}$'),
    running_version text check (
      running_version is null or (
        btrim(running_version) <> '' and char_length(running_version) <= 128
      )
    ),
    deployment_health text check (
      deployment_health in ('healthy', 'unhealthy', 'inconsistent', 'unavailable')
    ),
    origin_reachable boolean,
    origin_fingerprint_sha256 text check (
      origin_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    ),
    fingerprint_sha256 text not null check (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
    observed_at timestamptz not null,
    primary key (delivery_id, owner_user_id, evidence_revision),
    unique (
      delivery_id, owner_user_id, evidence_revision,
      pull_request_number, pull_request_head_sha
    ),
    foreign key (delivery_id, owner_user_id)
      references task_deliveries (id, owner_user_id) on delete restrict,
    foreign key (observing_execution_id, owner_user_id)
      references task_executions (id, owner_user_id) on delete restrict,
    check (
      (pull_request_number is null and pull_request_base_branch is null and
       pull_request_head_sha is null and
       pull_request_state is null and pull_request_draft is null) or
      (pull_request_number is not null and pull_request_base_branch is not null and
       pull_request_head_sha is not null and
       pull_request_state is not null and pull_request_draft is not null)
    ),
    check (
      (checks_state = 'unavailable' and checks_fingerprint_sha256 is null) or
      (checks_state <> 'unavailable' and checks_fingerprint_sha256 is not null)
    ),
    check (
      (review_state = 'unavailable' and review_commit_sha is null and
       review_fingerprint_sha256 is null and review_checked_at is null) or
      (review_state <> 'unavailable' and review_commit_sha is not null and
       review_fingerprint_sha256 is not null and review_checked_at is not null)
    ),
    check (
      (preview_state = 'unavailable' and preview_head_sha is null) or
      (preview_state <> 'unavailable' and preview_head_sha is not null)
    ),
    check (
      (deployment_environment is null and deployed_commit_sha is null and
       running_version is null and deployment_health is null and
       origin_reachable is null and origin_fingerprint_sha256 is null) or
      (btrim(deployment_environment) <> '' and
       deployed_commit_sha is not null and deployment_health is not null and
       origin_reachable is not null and origin_fingerprint_sha256 is not null)
    )
  );

  create index task_delivery_evidence_latest_idx
    on task_delivery_evidence (owner_user_id, delivery_id, evidence_revision desc);

  create table task_delivery_revision_reviews (
    id uuid not null,
    delivery_id uuid not null,
    owner_user_id text not null,
    pull_request_number integer not null check (pull_request_number > 0),
    pull_request_head_sha text not null check (pull_request_head_sha ~ '^[0-9a-f]{40}$'),
    evidence_revision bigint not null check (evidence_revision > 0),
    summary_fingerprint_sha256 text not null check (
      summary_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
    ),
    state text not null check (state in ('requested', 'approved', 'rejected')),
    requested_by_kind text not null check (
      requested_by_kind in ('human', 'orchestrator', 'agent')
    ),
    requested_by_id text not null check (
      btrim(requested_by_id) <> '' and char_length(requested_by_id) <= 256
    ),
    requested_at timestamptz not null,
    decided_by_kind text check (decided_by_kind in ('human', 'provider')),
    decided_by_id text check (
      decided_by_id is null or (
        btrim(decided_by_id) <> '' and char_length(decided_by_id) <= 256
      )
    ),
    decided_at timestamptz,
    primary key (id, owner_user_id),
    unique (delivery_id, owner_user_id, pull_request_head_sha),
    foreign key (
      delivery_id, owner_user_id, evidence_revision,
      pull_request_number, pull_request_head_sha
    ) references task_delivery_evidence (
      delivery_id, owner_user_id, evidence_revision,
      pull_request_number, pull_request_head_sha
    ) on delete restrict,
    check (
      (state = 'requested' and decided_by_kind is null and
       decided_by_id is null and decided_at is null) or
      (state in ('approved', 'rejected') and decided_by_kind is not null and
       decided_by_id is not null and decided_at is not null)
    )
  );
`;
