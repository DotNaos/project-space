export const taskHandoffArtifactMigrationId = '0035_task_handoff_artifacts';

export const taskHandoffArtifactMigrationSql = `
  alter table task_handoff_revisions
    add column requested_permissions jsonb;

  update task_handoff_revisions
     set requested_permissions = case
       when requested_mode in ('plan', 'review') then
         '{"delivery":"none","network":"restricted","repository":"read","task":"read","workspace":"read"}'::jsonb
       else
         '{"delivery":"pull_request","network":"restricted","repository":"write","task":"write","workspace":"write"}'::jsonb
     end;

  alter table task_handoff_revisions
    alter column requested_permissions set not null,
    add constraint task_handoff_requested_permissions_shape check (
      jsonb_typeof(requested_permissions) = 'object' and
      requested_permissions->>'delivery' in ('none', 'pull_request') and
      requested_permissions->>'network' in ('none', 'restricted', 'open') and
      requested_permissions->>'repository' in ('read', 'write') and
      requested_permissions->>'task' in ('read', 'write') and
      requested_permissions->>'workspace' in ('read', 'write') and
      requested_permissions = jsonb_build_object(
        'delivery', requested_permissions->>'delivery',
        'network', requested_permissions->>'network',
        'repository', requested_permissions->>'repository',
        'task', requested_permissions->>'task',
        'workspace', requested_permissions->>'workspace'
      )
    );

  alter table task_handoff_artifacts
    add column artifact_kind text not null default 'other',
    add column artifact_name text,
    add column verification_state text not null default 'unavailable',
    add column verified_at timestamptz;

  update task_handoff_artifacts set artifact_name = artifact_id;

  alter table task_handoff_artifacts
    alter column artifact_kind drop default,
    alter column artifact_name set not null,
    alter column verification_state drop default,
    add constraint task_handoff_artifact_kind check (
      artifact_kind in ('decision', 'design', 'document', 'other', 'screenshot')
    ),
    add constraint task_handoff_artifact_name check (
      btrim(artifact_name) <> '' and char_length(artifact_name) <= 512
    ),
    add constraint task_handoff_artifact_verification check (
      (verification_state = 'verified' and verified_at is not null) or
      (verification_state = 'unavailable' and verified_at is null)
    );

  create table task_handoff_artifact_blobs (
    id uuid not null,
    owner_user_id text not null check (btrim(owner_user_id) <> ''),
    digest_sha256 text not null check (digest_sha256 ~ '^[0-9a-f]{64}$'),
    media_type text not null check (
      media_type ~ '^[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+-]*$' and
      char_length(media_type) <= 128
    ),
    size_bytes bigint not null check (size_bytes between 0 and 8388608),
    content bytea not null,
    provenance_reference text not null check (
      provenance_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$'
    ),
    created_at timestamptz not null,
    primary key (id, owner_user_id),
    check (octet_length(content) = size_bytes)
  );

  create index task_handoff_artifact_blobs_digest_idx
    on task_handoff_artifact_blobs (owner_user_id, digest_sha256);
`;
