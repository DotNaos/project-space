# Connector retirement ledger

This ledger controls Stage 8 of the remote-development architecture. A replacement marked
available in source is not treated as deployed or safe to remove. The permanent Connector stays
supported until every row has runtime proof, rollback evidence, classified compatibility usage,
and a complete zero-use deprecation window.

| Current responsibility | Canonical owner | Current boundary | Delivery |
| --- | --- | --- | --- |
| Registration and environment identity | Environment bootstrap and immutable Environment Instance identity | Primary path pending | #648 |
| Online status | Access routes, provider state, Runtime Sessions, and optional project-hostd | Runtime proof pending | #649 |
| Remote command execution | Authorized SSH control gateway over an approved private-network route | Primary path pending | #647 |
| Project and worktree discovery | Typed Project CLI inventory and worktree operations | Primary path pending | #647 |
| Codex version and launch | Pinned Workspace Runtime manifest and Project CLI launch | Primary path pending | #647 |
| Codex streaming and steering | Outbound Workspace Runtime and Codex App Server WebSocket channels | Runtime proof pending | #647 |
| Development-server lifecycle | Project CLI lifecycle plus outbound Workspace Runtime events | Primary path pending | #647 |
| Private-network publication | Provider-neutral Private Network and Access Route adapters | Primary path pending | #647 |
| Resource reporting | Workspace Runtime telemetry and optional outbound project-hostd | Runtime proof pending | #649 |
| Connector self-update | Explicit Project CLI update and rare scoped project-hostd upgrade | Primary path pending | #648 |

## Focused delivery sequence

1. #646 removes Machines and Connector installations from the primary visible compute hierarchy.
2. #647 moves remaining Git, Worktree, task, Codex, and development-server dispatch to canonical
   Environment Instance and Workspace Runtime targets.
3. #648 stops new permanent Connector installation and moves bootstrap/update to the Project CLI.
4. #649 records privacy-preserving successful compatibility use and calculates a fail-closed
   retirement report.
5. #650 removes the permanent Connector only after the complete observed gate passes.

## Compatibility boundary

- Existing versioned endpoints and CLI aliases remain during the deprecation window.
- An alias must enter the same canonical target resolver and authorization policy as its
  replacement. It cannot dispatch directly by Connector ID.
- Connector IDs, legacy machine IDs, hostnames, IP addresses, and provider IDs are never
  reinterpreted as Host, Environment Instance, or Workspace Runtime IDs.
- Compatibility telemetry may store only a classified surface, result, counter, and timestamps.
  It must never retain request bodies, target identifiers, paths, credentials, secrets, or model
  content.
- New Worktrees and tool versions use a pinned Workspace Runtime and never create another
  permanent Connector installation.

## Removal gate

Removal is blocked until all replacement revisions are merged and deployed, realistic runtime
proof exists for each row, the rollback drill succeeds, the deprecation window is explicitly
configured, all successful compatibility use is classified, that full window observes zero use,
and the predictable old-client failure contract has shipped. Missing, stale, local-only, or
ambiguous evidence keeps the gate closed. The final destructive step is isolated in #650.
