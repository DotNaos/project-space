---
title: Codex sessions
description: Machine-owned Codex App Server sessions in Project Space.
---

# Codex sessions

Project Space exposes stored Codex tasks through the authenticated connector on the machine that
owns them. The browser never connects to Codex App Server directly. A connector-owned, long-lived
App Server process is the only runtime whose loaded and live states Project Space reports.

## Product decisions

- The selected interface is Variant A: machine/session list, conversation, and details/decisions.
- Opening history is read-only. It uses `thread/read` and never resumes or subscribes to the task.
- Loaded state is labelled **Loaded by Project Space** because App Server loaded state is
  process-local and cannot describe a separate Codex client.
- Starting a new turn while one is active is rejected until the current turn becomes idle. Project
  Space does not silently queue or steer work.
- Stable machine and thread IDs route every operation. Titles are descriptive only.

## Threat invariants

1. A signed-in user must own the selected machine before any connector request is dispatched.
2. Every mutating connector request carries a short-lived signed operation grant bound to user,
   machine, operation, thread, request ID, and runtime generation.
3. The connector exposes a fixed typed method set. It does not accept arbitrary App Server methods,
   commands, paths, URLs, environment variables, or process inputs from the browser.
4. App Server stays on local stdio or a machine-local Unix socket. It is not exposed to the public
   internet, LAN, or Tailnet.
5. History responses omit internal paths beyond the task working directory, raw process output,
   environment data, credentials, Git origins with credentials, and unknown extension fields.
6. Resume and turn start use a durable operation ID. Retries return or reconcile the original
   outcome; an ambiguous crash window is shown honestly and is never retried as a fresh turn.
7. Approval and input requests retain their App Server request, task, turn, and item IDs until the
   server resolves them. No default human choice is invented.
8. Connector disconnects, App Server restarts, missing tasks, and offline machines fail closed and
   never become empty success states.

## Delivery slices

1. List stored, archived, and Project-Space-loaded tasks by machine; read history without loading.
2. Resume an idle task, start one idempotent turn, and stream task, turn, item, and text updates.
3. Preserve approvals, permission prompts, user-input requests, interruption, and reject-until-idle.
4. Open the exact machine/thread origin from Project Chat and support direct Codex session routes.
5. Reconcile reconnects, App Server restarts, offline/missing tasks, and multiple machines.

## Finishing criteria

- Automated tests cover list, loaded list, archived list, read, resume, start, streaming, approvals,
  user input, authorization, isolation, reconnect, restart, offline/missing state, and duplicates.
- The exact source task `019f5a78-3c4c-7082-bb45-5411be7d9b9a` is found through the real local
  App Server, and a read proves it remains unloaded.
- A controlled continuation appends to that same task ID and streams visibly without duplicate work.
- Desktop and 390-pixel layouts are dogfooded through the Portless URL in Browser.
- Focused and full TypeScript/Bun and Go tests, typecheck, production build, and repository quality
  checks pass before the pull request is marked ready.

## Real dogfooding setup

The connector uses `/Applications/ChatGPT.app/Contents/Resources/codex` on this Mac because the
PATH-installed wrappers are broken. Dogfooding uses a long-lived local stdio process, the actual
Project-managed #149 worktree, Portless for the web URL, and Browser at desktop and narrow widths.
The source task is opened read-only first. Any real continuation uses a harmless, explicit prompt,
waits for idle, records its operation ID, and verifies the same task ID afterward.
