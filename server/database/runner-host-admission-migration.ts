export const runnerHostAdmissionMigrationId = '0058_runner_host_admission';

export const runnerHostAdmissionMigrationSql = `
  create table runner_sandbox_reservations (
    reservation_id text primary key check (btrim(reservation_id) <> '' and char_length(reservation_id) <= 256),
    host_id text not null check (btrim(host_id) <> '' and char_length(host_id) <= 256),
    host_generation text not null check (btrim(host_generation) <> '' and char_length(host_generation) <= 256),
    identity jsonb not null check (jsonb_typeof(identity) = 'object'),
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
      absence_proof->>'generation' = host_generation and
      absence_proof->>'resourcesAbsent' = 'true'
    ))
  );

  create index runner_sandbox_reservations_host_state_idx
    on runner_sandbox_reservations (host_id, state, created_at);
`;
