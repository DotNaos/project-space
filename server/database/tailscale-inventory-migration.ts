export const tailscaleInventoryMigrationId = '0053_tailscale_inventory';

export const tailscaleInventoryMigrationSql = `
  create table tailscale_device_observations (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    device_id text not null check (
      device_id ~ '^[A-Za-z0-9._:-]+$' and char_length(device_id) between 1 and 256
    ),
    observed_name text check (
      observed_name is null or (
        btrim(observed_name) <> '' and char_length(observed_name) <= 128 and
        observed_name !~ '[[:cntrl:]]'
      )
    ),
    addresses inet[] not null check (cardinality(addresses) between 1 and 32),
    online boolean not null,
    os text check (os is null or (char_length(os) <= 128 and os !~ '[[:cntrl:]]')),
    tags text[] not null default '{}'::text[] check (cardinality(tags) <= 64),
    observed_at timestamptz not null,
    fresh_until timestamptz not null,
    last_seen_at timestamptz,
    inventory_state text not null default 'current'
      check (inventory_state in ('current', 'stale')),
    stale_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, device_id),
    check ((inventory_state = 'current') = (stale_at is null)),
    check (fresh_until > observed_at)
  );

  create index tailscale_device_observations_owner_state_idx
    on tailscale_device_observations (owner_user_id, inventory_state, device_id);

  create table tailscale_device_classifications (
    owner_user_id text not null,
    device_id text not null,
    classification text not null default 'unclassified' check (
      classification in (
        'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
      )
    ),
    revision integer not null default 0 check (revision >= 0),
    actor_id text not null check (btrim(actor_id) <> '' and char_length(actor_id) <= 256),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, device_id),
    foreign key (owner_user_id, device_id)
      references tailscale_device_observations (owner_user_id, device_id) on delete restrict
  );

  create table tailscale_device_classification_audits (
    id bigserial primary key,
    owner_user_id text not null,
    device_id text not null,
    actor_id text not null check (
      btrim(actor_id) <> '' and char_length(actor_id) <= 256 and actor_id !~ '[[:cntrl:]]'
    ),
    previous_classification text not null check (
      previous_classification in (
        'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
      )
    ),
    next_classification text not null check (
      next_classification in (
        'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
      )
    ),
    revision integer not null check (revision > 0),
    created_at timestamptz not null default now(),
    foreign key (owner_user_id, device_id)
      references tailscale_device_classifications (owner_user_id, device_id) on delete restrict
  );

  create index tailscale_device_classification_audits_owner_device_idx
    on tailscale_device_classification_audits (owner_user_id, device_id, id desc);

  create table tailscale_compute_environment_projections (
    owner_user_id text not null,
    device_id text not null,
    environment_id uuid not null,
    classification_revision integer not null check (classification_revision > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, device_id),
    unique (owner_user_id, environment_id),
    foreign key (owner_user_id, device_id)
      references tailscale_device_classifications (owner_user_id, device_id) on delete restrict,
    foreign key (environment_id, owner_user_id)
      references compute_environments (id, owner_user_id) on delete restrict
  );

  create index tailscale_compute_environment_projections_environment_idx
    on tailscale_compute_environment_projections (owner_user_id, environment_id);
`;
