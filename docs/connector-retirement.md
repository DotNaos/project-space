# Connector retirement

The permanent Project Space Connector has been retired. This is an immediate
product boundary: there is no 30-day compatibility window and no new permanent
Connector installation path.

```mermaid
flowchart LR
  OLD[Legacy Connector artifacts] -->|cleanup only| CLEAN[Scoped uninstall or upgrade cleanup]
  AUTH[project connect] --> CRED[Machine Credential]
  CRED --> USER[Environment Instance]
  USER --> BOOT[project environment bootstrap]
  BOOT --> RT[Pinned Workspace Runtime]
  RT --> SESSION[Generation-bound Runtime Session]
```

The valid path starts from an exact Environment Instance and launches a pinned
Workspace Runtime. The invalid path is any attempt to install, enroll, start,
or route work through a permanent Connector. `project connect` remains valid:
it enrolls only the owner-bound Machine Credential used for authenticated
control requests. Enforcement belongs at the
bootstrap and runtime boundaries, so a stale Connector executable cannot
bypass the canonical Environment and Workspace identity checks.

## Canonical replacements

| Retired responsibility | Canonical owner |
| --- | --- |
| CLI authentication | Owner-bound Machine Credential from `project connect` |
| Environment identity | Environment bootstrap and immutable Environment Instance identity |
| Codex version and launch | Pinned Workspace Runtime manifest and Project CLI launch |
| Codex streaming and steering | Outbound Workspace Runtime and Codex App Server channels |
| Project and worktree operations | Project CLI against the exact managed Workspace |
| Development-server lifecycle | Workspace Runtime lifecycle and typed runtime events |
| Resource reporting | Workspace Runtime telemetry and optional project-hostd |
| Connector self-update | Explicit Project CLI update; no background Connector updater |

Use [Compute Platforms, Hosts, and Environments](./compute-environments.md),
[Workspace runtimes](./workspace-runtimes.md), and [Workspace Runtime
sessions](./workspace-runtime-sessions.md) for the active contracts.

## Compatibility and cleanup boundary

- Old Connector binaries, service names, scheduled tasks, LaunchAgents, and
  credentials may be recognized only to remove them safely.
- Cleanup is exact and fail-closed. It must not invoke the retired binary,
  reconnect it, or delete unrelated user-owned files.
- Connector IDs, legacy machine IDs, hostnames, IP addresses, and provider IDs
  are never reinterpreted as Environment, Workspace, or Runtime IDs.
- The signed release manifest remains
  `project-space.connector-runtime-release/v1`; its schema and parser are
  unchanged for installed v0.21.17 clients.
