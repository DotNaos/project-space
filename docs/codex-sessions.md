---
title: Codex sessions
description: Machine-owned Codex App Server sessions in Project Space.
---

# Codex sessions

Project Space exposes stored Codex tasks through the authenticated Workspace
Runtime that owns them. The browser never connects to Codex App Server
directly. A generation-scoped Runtime session is the only live transport whose
loaded and live states Project Space reports.
Project Space, Codex Desktop, and other paired Codex clients therefore observe the same canonical
thread IDs and live state.

## Product decisions

- The project Codex tab groups project-scoped tasks by the canonical Environment
  and Workspace Runtime. Legacy physical-machine records remain read-only
  compatibility data; see
  [Compute Platforms, Hosts, and Environments](./compute-environments.md). Project Chat shows only a
  compact active-task count; opening it reveals the same grouped tasks in a temporary drawer.
- Both project entry points open one canonical task workspace at
  `/codex/machines/:machineId/threads/:threadId`. Task titles are descriptive and never route keys.
- Project Chat and issue detail pages can create an empty persistent Codex task after the user
  chooses an online Codex machine and a ready worktree for the current project. The issue entry
  point keeps the issue number visible as context, while the exact worktree path remains the task's
  execution boundary.
- An issue's Runner tab lists only Codex tasks whose verified project scope and issue identity match
  that issue. Its Pipeline tab shows the linked GitHub workflow run, pull request, and Preview status
  directly; neither tab redirects through the broader Compute inventory.
- Task rows use the task name as their only primary text. Issue and pull-request references are
  separate metadata, and active work uses a spinner instead of a static “Running” status.
- Opening history is read-only. It uses `thread/read` and never resumes or subscribes to the task.
- Loaded state comes from the owning Runtime session and is never inferred from
  another Environment or a stale registry snapshot.
- Message delivery is explicit. `new-turn` rejects while a turn is active, `steer` requires the
  exact active turn ID, `queue` persists one unresolved follow-up and dispatches it when the thread
  becomes idle, and `auto` selects an exact steer only when live evidence identifies the active
  turn. Operation replays never create a second turn.
- The task workspace contains the stored conversation, live streaming, composer, approval and
  input handling without a second task list or a redundant details inspector.
- On desktop, live agent-browser activity opens a resizable chat/browser split. A manual collapse
  lasts for the current turn. Narrow layouts use a Chat/Browser switch.

## Threat invariants

1. A signed-in user must own the selected Environment and Workspace before any Runtime request is dispatched.
2. Every mutating Runtime request carries a short-lived signed operation grant bound to user,
   Environment, Workspace, operation, thread, request ID, and generation.
3. The Runtime exposes a fixed typed method set. It does not accept arbitrary App Server methods,
   commands, paths, URLs, environment variables, or process inputs from the browser.
4. App Server stays on its machine-local Unix socket. Project Space never opens an unauthenticated
   TCP listener on the public internet, LAN, or Tailnet.
5. History responses omit internal paths beyond the task working directory, raw process output,
   environment data, credentials, Git origins with credentials, and unknown extension fields.
6. Resume and turn start use a durable operation ID. Retries return or reconcile the original
   outcome; an ambiguous crash window is shown honestly and is never retried as a fresh turn.
   Queued follow-ups retain the owner, target generation, message fingerprint, and operation ID.
   Their initial reservation also retains the normalized request fingerprint and queued result, so
   startup can reconcile a crash before dispatch and exact completed replays do not need live target
   discovery.
   A reconnect may rebind an undispatched queue entry only when both generations advertise durable
   operations; otherwise the stale entry is blocked without dispatch.
7. Approval and input requests retain their App Server request, task, turn, and item IDs until the
   server resolves them. No default human choice is invented.
8. Runtime disconnects, App Server restarts, missing tasks, and unavailable Environments fail closed
   and never become empty success states.
9. Browser snapshots are read-only, identity-bound to the authenticated machine and task, and
   sanitized before leaving the Workspace Runtime. Browser runtime, tab, and session identifiers are never
   exposed publicly or added to the canonical URL.
10. An ended browser may retain its final read-only frame, but it is never labelled live or reused
    by a later turn. Loading, reconnecting, offline, unauthorized, and unavailable states are
    represented honestly.
11. Browser polling uses its own separately negotiated, signed Runtime operation and never loads or
    serializes task history. Decoded frames are capped at 1,500,000 bytes so the base64 image and
    signed JSON result remain below the Runtime's 2 MiB WebSocket message limit.

## Delivery slices

1. List stored, archived, and Project-Space-loaded tasks by machine; read history without loading.
2. Resume an idle task, start one idempotent turn, and stream task, turn, item, and text updates.
3. Preserve approvals, permission prompts, user-input requests, interruption, exact active-turn
   steering, explicit reject-until-idle, and durable idle dispatch.
4. Open the exact machine/thread origin from the project Codex tab or Project Chat and support
   direct canonical task URLs and legacy URL canonicalization.
5. Mirror the authenticated active browser safely, including reconnect and lifecycle states.
6. Reconcile App Server restarts, offline/missing tasks, and multiple machines.
7. Report Workspace Runtime, App Server, and account readiness through the
   canonical Runtime inspection path.

## Finishing criteria

- Automated tests cover list, loaded list, archived list, read, resume, start, streaming, approvals,
  user input, authorization, isolation, reconnect, restart, offline/missing state, browser lifecycle,
  canonical routing, project entry points, responsive layout, and duplicates.
- The exact source task `019f5a78-3c4c-7082-bb45-5411be7d9b9a` is found through the real local
  App Server, and a read proves it remains unloaded.
- A controlled continuation appends to that same task ID and streams visibly without duplicate work.
- Desktop and 390-pixel layouts are dogfooded through the Portless URL in Browser.
- Focused and full TypeScript/Bun and Go tests, typecheck, production build, and repository quality
  checks pass before the pull request is marked ready.

## Managed daemon lifecycle

Project Doctor provisions only the Codex binary pinned inside a signed managed Runtime release.
It uses Codex's idempotent daemon lifecycle commands without enabling the standalone updater or
downloading another binary. Existing `CODEX_HOME`, authentication, configuration, approvals,
pairing state, and thread storage remain in place.

Diagnosis passively verifies the daemon's Unix control socket, App Server version, account state,
and initial Remote Control status notification. Repair may enable Remote Control and start or
restart the daemon. A user-only pairing step is reported explicitly and is never replaced with
remote shell access or credential handling.
