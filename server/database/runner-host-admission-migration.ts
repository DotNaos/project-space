export const runnerHostAdmissionMigrationId = '0058_runner_host_admission';

export const runnerHostAdmissionMigrationSql = `
  create table runner_sandbox_reservations (
    reservation_id text primary key check (btrim(reservation_id) <> '' and char_length(reservation_id) <= 256),
    host_id text not null check (btrim(host_id) <> '' and char_length(host_id) <= 256),
    host_generation text not null check (btrim(host_generation) <> '' and char_length(host_generation) <= 256),
    identity jsonb not null check (jsonb_typeof(identity) = 'object'),
    check (jsonb_object_length(identity) = 13),
    check (identity ?& array[
      'baseSha', 'branch', 'codexTaskId', 'generation', 'hostId', 'issueNumber',
      'operationId', 'ownerUserId', 'projectManagerTaskId', 'repositoryId',
      'reservationId', 'taskId', 'workspaceId'
    ]),
    check (coalesce(
      jsonb_typeof(identity->'baseSha') = 'string' and
      btrim(identity->>'baseSha') = identity->>'baseSha' and
      char_length(identity->>'baseSha') between 1 and 256 and
      identity->>'baseSha' !~ '[[:cntrl:]]' and
      identity->>'baseSha' ~ '^[0-9a-f]{40}$', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'branch') = 'string' and
      btrim(identity->>'branch') = identity->>'branch' and
      char_length(identity->>'branch') between 1 and 256 and
      identity->>'branch' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'codexTaskId') = 'string' and
      btrim(identity->>'codexTaskId') = identity->>'codexTaskId' and
      char_length(identity->>'codexTaskId') between 1 and 256 and
      identity->>'codexTaskId' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'generation') = 'string' and
      btrim(identity->>'generation') = identity->>'generation' and
      char_length(identity->>'generation') between 1 and 256 and
      identity->>'generation' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'hostId') = 'string' and
      btrim(identity->>'hostId') = identity->>'hostId' and
      char_length(identity->>'hostId') between 1 and 256 and
      identity->>'hostId' !~ '[[:cntrl:]]' and
      identity->>'hostId' = host_id, false
    )),
    check (coalesce(
      jsonb_typeof(identity->'operationId') = 'string' and
      btrim(identity->>'operationId') = identity->>'operationId' and
      char_length(identity->>'operationId') between 1 and 256 and
      identity->>'operationId' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'ownerUserId') = 'string' and
      btrim(identity->>'ownerUserId') = identity->>'ownerUserId' and
      char_length(identity->>'ownerUserId') between 1 and 256 and
      identity->>'ownerUserId' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'projectManagerTaskId') = 'string' and
      btrim(identity->>'projectManagerTaskId') = identity->>'projectManagerTaskId' and
      char_length(identity->>'projectManagerTaskId') between 1 and 256 and
      identity->>'projectManagerTaskId' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'repositoryId') = 'string' and
      btrim(identity->>'repositoryId') = identity->>'repositoryId' and
      char_length(identity->>'repositoryId') between 1 and 256 and
      identity->>'repositoryId' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'reservationId') = 'string' and
      btrim(identity->>'reservationId') = identity->>'reservationId' and
      char_length(identity->>'reservationId') between 1 and 256 and
      identity->>'reservationId' !~ '[[:cntrl:]]' and
      identity->>'reservationId' = reservation_id, false
    )),
    check (coalesce(
      jsonb_typeof(identity->'taskId') = 'string' and
      btrim(identity->>'taskId') = identity->>'taskId' and
      char_length(identity->>'taskId') between 1 and 256 and
      identity->>'taskId' !~ '[[:cntrl:]]', false
    )),
    check (coalesce(
      jsonb_typeof(identity->'workspaceId') = 'string' and
      btrim(identity->>'workspaceId') = identity->>'workspaceId' and
      char_length(identity->>'workspaceId') between 1 and 256 and
      identity->>'workspaceId' !~ '[[:cntrl:]]', false
    )),
    check (case when jsonb_typeof(identity->'issueNumber') = 'number'
      then (identity->>'issueNumber')::numeric > 0 and
        (identity->>'issueNumber')::numeric = trunc((identity->>'issueNumber')::numeric) and
        (identity->>'issueNumber')::numeric <= 9007199254740991
      else false end),
    isolation jsonb not null check (jsonb_typeof(isolation) = 'object'),
    resources jsonb not null check (jsonb_typeof(resources) = 'object'),
    state text not null check (state in ('active', 'uncertain', 'released')),
    fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null,
    idle_timeout_seconds integer not null check (idle_timeout_seconds > 0),
    maximum_runtime_seconds integer not null check (maximum_runtime_seconds > 0),
    idle_expires_at timestamptz not null,
    lease_expires_at timestamptz not null,
    runtime_expires_at timestamptz not null,
    absence_proof jsonb,
    check (host_generation = identity->>'generation'),
    check (idle_expires_at > created_at),
    check (lease_expires_at > created_at),
    check (runtime_expires_at > created_at),
    check ((state = 'released') = (absence_proof is not null)),
    check (absence_proof is null or (
      jsonb_typeof(absence_proof) = 'object' and
      jsonb_typeof(absence_proof->'identity') = 'object' and
      absence_proof->'identity' = identity and
      absence_proof->'identity'->>'generation' = host_generation and
      jsonb_typeof(absence_proof->'checkedAt') = 'string' and
      absence_proof->>'resourcesAbsent' = 'true'
    ))
  );

  create index runner_sandbox_reservations_host_state_idx
    on runner_sandbox_reservations (host_id, state, created_at);
`;
