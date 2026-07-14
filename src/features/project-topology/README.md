# Project topology command center

This feature builds one evidence-based portfolio snapshot for the Lead, project,
machine, and Codex task hierarchy. It is deliberately fail-closed: an unavailable
source becomes Checking, Limited, Blocked, or Stale rather than an empty slot.

## Finishing criteria

- The overview uses real project, machine, checkout, GitHub, Codex, and deployment
  inventories. Production code contains no topology fixtures.
- A task is attached only when a connector-provided canonical cwd maps uniquely to
  a usable project checkout on the same machine.
- A machine says `No active tasks` only after successful Codex inventory and after
  every returned task has been attributed.
- Detailed transcript reads and streams remain bound to the exact machine and
  thread identity.
- The base portfolio publishes before task transcript enrichment; refreshes abort
  superseded source requests and late results cannot replace newer evidence.
- A composer appears only with a current transcript and a short-lived write
  capability for the same session generation. The action layer rechecks that
  capability immediately before dispatch.
- Failed refreshes retain the last safe transcript for reading, but remove every
  write and browser capability.
- Project and machine focus keep text at a readable native scale on narrow screens.
- Focused task expansion can be cancelled and respects reduced-motion settings.

## Capability gates

Browser preview is unavailable until Project Space has an authenticated,
task-bound relay with an isolated read-only frame and separately authorized
Console, Network, and Logs streams. A dev-server URL is not such a capability and
must never produce a frame. The current model therefore always returns an honest
unavailable browser state.

Canonical cwd resolution and write capability minting are explicit source
operations. If either operation is unsupported by a connector host, task
attribution stays Limited or the composer stays hidden. The browser never submits
paths, roots, executables, operation IDs, or shell text.

Every inventory adapter must return an explicit Ready, Stale, or Blocked result.
Ready timestamps must come from the completed source read. Cached or offline data
must remain Stale with its original `lastSafeAt`; an adapter must not wrap it as a
new Ready result. Malformed, future-dated, or internally inconsistent evidence is
rejected before it can make an inventory look current or empty.

Awaiting-decision and verified-complete statuses also require exact task evidence
from the source boundary. They are not inferred from an idle session, issue state,
or branch name.

## Integration boundary

Pure evidence, layout, motion, presentation, loading, streaming, and action
modules live in this folder. React Flow should own only the topology canvas and
node positioning. The existing Codex sessions controller remains the detailed
workspace authority for real transcript streaming, approvals, user input,
continue, and interrupt operations.

Route, shell, API, connector, and package changes remain intentionally outside
this folder until the active owners of those shared files provide stable commits.
At that point the production adapter must implement the source contracts here,
add the React Flow dependency, and wire the smallest possible route and rail entry.

## Evidence gates

Focused unit tests cover task attribution, duplicate and multi-machine occupancy,
unavailable and stale inventory, delivery evidence, capability expiry, retained
last-safe snapshots, action authorization, layout readability, and transition
cancellation. Final integration still requires the repository checks, production
build, Portless startup, and Browser-first desktop and narrow-viewport dogfooding.
