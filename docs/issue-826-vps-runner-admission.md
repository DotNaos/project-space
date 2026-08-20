# VPS Project Manager and sandbox admission

This milestone adds the fail-closed admission boundary for the VPS runner. It
does not change Production deployment or connect to the VPS.

The Project Manager remains a supervised control-plane workload. Each worker
owns one stable Runner Workspace identity, Project-managed worktree, Codex task,
operation, and generation. The runner may admit a sandbox only after it has a
fresh capacity observation, healthy Production evidence, and positive cleanup
evidence for previously owned resources.

## Admission proof

`reserved` means all of these are true at the same time:

- capacity evidence is present, not future-dated, within the 30-second freshness
  window, and not expired;
- Production is healthy and the effective Production claim
  `max(productionUsage, productionReservation)` fits within total capacity;
- the requested profile fits the per-sandbox and aggregate limits;
- the requested profile fits the remaining total after the effective Production claim;
- concurrency is below both the configured and observed host limit;
- no active sandbox has uncertain cleanup;
- every active durable reservation has a valid exact host/generation identity, bounded
  resource/scalar values, coherent deadlines, and a canonical fingerprint;
- idle, maximum-runtime, and lease windows are bounded;
- the reservation identity and request fingerprint are new or an exact replay;
- any release proof names the exact full reservation identity, has `resourcesAbsent: true`,
  and has a checked-at timestamp no older than 30 seconds and never future-dated (zero
  tolerated clock skew).

Missing, stale, unhealthy, or uncertain evidence returns `blocked(...)`; it
never falls back to an optimistic reservation. An uncertain stop remains an
owner of capacity until a same-generation absence proof for the exact reservation,
workspace, task, Project Manager task, Codex task, and operation confirms that its
processes, ports, storage, and mounts are gone. A proof from another reservation or
an old, future-dated, or replayed proof is rejected.

## Resource and isolation policy

`.project/runner.yaml` is the reviewed non-Production profile. It bounds CPU,
memory and swap, PIDs, open files, writable disk and inodes, I/O, network
connections and ports, logs, model concurrency, CPU scheduling weight, I/O
weight, idle time, maximum runtime, leases, and aggregate concurrency. It also records the required isolation
boundary: no host Docker socket, host network, Production filesystem/database,
deployment credentials, or cross-sandbox writable volumes.

The profile is deliberately not a deployment secret and contains no host
address, credential, or mutable image reference. A future VPS wiring change
must consume this contract through the Runner Host -> Runner Workspace -> Agent
Task provider boundary from #446. It must not run worker commands in the
Production container or reuse the Production Compose project.

## Remaining integration boundary

The existing Task Execution capacity lease remains the compatibility path for
current Environments. A follow-up provider integration must call this admission
service before creating a Runner Workspace, persist the reservation and
capacity evidence in the control plane, and expose the exact blocked reason and
evidence timestamp to operators. This PR proves admission and persistence only;
it does not prove end-to-end sandbox isolation or enforce these limits on a live
VPS. PostgreSQL cross-process locking is covered by an opt-in loopback integration
test using real transactions; the default unit test client covers query shape and
fails closed when transaction support is absent. VPS deployment, network changes, secrets, and Production state remain
untouched.
