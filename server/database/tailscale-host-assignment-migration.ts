export const tailscaleHostAssignmentMigrationId = '0060_tailscale_host_assignments';

export const tailscaleHostAssignmentMigrationSql = `
  create table tailscale_device_host_assignments (
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    device_owner_user_id text not null check (btrim(device_owner_user_id) <> ''),
    device_id text not null,
    host_id uuid,
    revision integer not null default 0 check (revision >= 0),
    actor_id text not null check (
      btrim(actor_id) <> '' and char_length(actor_id) <= 256 and actor_id !~ '[[:cntrl:]]'
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (owner_user_id, device_owner_user_id, device_id),
    foreign key (device_owner_user_id, device_id)
      references tailscale_device_observations (owner_user_id, device_id) on delete restrict,
    foreign key (host_id, owner_user_id)
      references physical_machines (id, owner_user_id) on delete restrict
  );

  create index tailscale_device_host_assignments_host_idx
    on tailscale_device_host_assignments (owner_user_id, host_id, device_id)
    where host_id is not null;

  create table tailscale_device_host_assignment_audits (
    id bigserial primary key,
    owner_user_id text not null,
    device_owner_user_id text not null,
    device_id text not null,
    actor_id text not null check (
      btrim(actor_id) <> '' and char_length(actor_id) <= 256 and actor_id !~ '[[:cntrl:]]'
    ),
    previous_host_id uuid,
    next_host_id uuid,
    revision integer not null check (revision > 0),
    created_at timestamptz not null default now(),
    foreign key (owner_user_id, device_owner_user_id, device_id)
      references tailscale_device_host_assignments (
        owner_user_id, device_owner_user_id, device_id
      ) on delete restrict
  );

  create index tailscale_device_host_assignment_audits_device_idx
    on tailscale_device_host_assignment_audits (
      owner_user_id, device_owner_user_id, device_id, id desc
    );
`;
