export const connectorMachineMembershipMigrationId =
  '0027_connector_machine_membership_required';

export const connectorMachineMembershipMigrationSql = `
  alter table physical_machines
    add column kind text not null default 'physical'
    check (kind in ('physical', 'virtual'));

  alter table physical_machines
    alter column kind drop default;

  alter table machine_connection_requests
    add column physical_machine_id uuid;

  update machine_connection_requests
     set status = 'expired'
   where status = 'approved';

  with orphan_connectors as (
    select identity.id as connector_id,
           identity.owner_user_id,
           identity.name,
           md5(
             'project-space:physical-machine:'
             || identity.owner_user_id
             || ':'
             || identity.id
           ) as identity_hash
      from machine_identities identity
     where not exists (
       select 1
         from physical_machine_connectors connector
        where connector.owner_user_id = identity.owner_user_id
          and connector.connector_id = identity.id
     )
  ), fallback_machines as (
    select connector_id,
           owner_user_id,
           left(name, 80) as name,
           (
             substr(identity_hash, 1, 8) || '-'
             || substr(identity_hash, 9, 4) || '-4'
             || substr(identity_hash, 14, 3) || '-a'
             || substr(identity_hash, 18, 3) || '-'
             || substr(identity_hash, 21, 12)
           )::uuid as physical_machine_id
      from orphan_connectors
  )
  insert into physical_machines (id, owner_user_id, kind, name)
  select physical_machine_id, owner_user_id, 'physical', name
    from fallback_machines
  on conflict (id, owner_user_id) do nothing;

  with orphan_connectors as (
    select identity.id as connector_id,
           identity.owner_user_id,
           md5(
             'project-space:physical-machine:'
             || identity.owner_user_id
             || ':'
             || identity.id
           ) as identity_hash
      from machine_identities identity
     where not exists (
       select 1
         from physical_machine_connectors connector
        where connector.owner_user_id = identity.owner_user_id
          and connector.connector_id = identity.id
     )
  )
  insert into physical_machine_connectors (
    physical_machine_id, owner_user_id, connector_id
  )
  select (
           substr(identity_hash, 1, 8) || '-'
           || substr(identity_hash, 9, 4) || '-4'
           || substr(identity_hash, 14, 3) || '-a'
           || substr(identity_hash, 18, 3) || '-'
           || substr(identity_hash, 21, 12)
         )::uuid,
         owner_user_id,
         connector_id
    from orphan_connectors
  on conflict (owner_user_id, connector_id) do nothing;

  update machine_connection_requests request
     set physical_machine_id = connector.physical_machine_id
    from machine_identities identity
    join physical_machine_connectors connector
      on connector.owner_user_id = identity.owner_user_id
     and connector.connector_id = identity.id
   where request.status = 'consumed'
     and request.public_key = identity.public_key
     and request.approved_by_user_id = identity.owner_user_id;

  alter table machine_connection_requests
    add constraint machine_connection_requests_physical_machine_state_check
    check (
      (status in ('approved', 'consumed') and physical_machine_id is not null)
      or (status in ('pending', 'denied') and physical_machine_id is null)
      or status = 'expired'
    ),
    add constraint machine_connection_requests_physical_machine_fk
    foreign key (physical_machine_id, approved_by_user_id)
    references physical_machines (id, owner_user_id)
    deferrable initially deferred;

  alter table machine_identities
    add constraint machine_identities_physical_machine_connector_fk
    foreign key (owner_user_id, id)
    references physical_machine_connectors (owner_user_id, connector_id)
    deferrable initially deferred;
`;
