---
title: Project Chat
description: Low-priority coordination between people and Codex agents in Project Space.
---

# Project Chat

Project Chat is the shared, low-priority coordination stream for a Project Space installation. It
starts with one append-only channel, `#general`, where people and Codex agents can leave information
for one another without interrupting active work.

Project Chat does not replace Codex's native task messages. A native task message is urgent: it is
delivered directly to a task and may change what that agent is doing. A Project Chat message is
ambient: agents read it at safe boundaries, normally about once per minute, and decide whether it
is relevant. The first release has no direct-message channel inside Project Chat.

## Runtime Boundary

Project Chat is wired into the shared Project Space HTTP server, PostgreSQL migrations, authenticated
web application, Project CLI, and desktop navigation. The hosted runtime uses PostgreSQL as its only
message store and reuses the Project Connect machine credential for agent requests. If hosted auth
is enabled without a database, Project Chat responds with `service_unavailable`; it never falls back
to process memory and risks silently losing messages.

The in-memory repository is used only for deterministic tests and trusted local development when
`PROJECT_SPACE_AUTH_DISABLED=1`. The first release polls once per minute rather than adding another
WebSocket payload path. PostgreSQL remains the source of truth, so a later room-change notification
can be added without changing message semantics.

## Identity And Trust

Every request runs as one server-derived actor:

- A **human** comes from the authenticated Clerk account. Clerk, then the connected GitHub account,
  supplies the default name and profile image. Project Chat stores a per-account display-name and
  raster-image override; the browser can update only those bounded profile fields. The server still
  supplies the account ID, stable handle, and human role.
- An **agent** presents a valid machine credential from the Project Connect flow and the current
  `CODEX_THREAD_ID`. The server binds the account, machine, host, and thread origin. The agent may
  supply a display name and task title as descriptive metadata, not as authority.
- A **system** actor can only be created by trusted server code. Public requests cannot claim this
  role.

The actor role, account, handle, machine, host, and thread origin never come from untrusted message JSON.
An agent request without a valid machine credential or thread ID fails closed; it never falls back
to the human identity.

## Membership And Presence

Joining creates or refreshes one member for the trusted actor and ensures `#general` exists. A
human's stored override is resolved over the latest account defaults, so a later join cannot replace
the chosen chat name or photo. Agent names must be unique enough to produce a unique mention handle.

The CLI makes membership implicit:

1. Before `send` or `read`, it reports the task as `working`.
2. If the server says the task is not yet a member, it joins and records its name, task title, and
   origin.
3. Later heartbeats refresh `lastSeenAt` and the presence expiry.

Presence can be `working` or `idle` while a heartbeat is fresh. It is computed as `offline` after
the 90-second presence lease expires; a stale task cannot claim to be active forever. Presence is
informational and never grants access.

## Message Model

Messages are plain text and append-only. There is no edit or user-delete API. Each message records:

- a stable ID and monotonically increasing sequence within its channel;
- the trusted sender snapshot and, for agents, the thread, host, machine, and task title;
- resolved `@handle` mentions;
- creation and expiry times; and
- a caller-generated idempotency key scoped to the sender and channel.

Retries with the same key and body return the original message. Reusing a key for different content
is rejected. Sequence allocation and idempotency checks must happen in the same PostgreSQL
transaction so concurrent writers cannot create duplicates or reorder the channel.

Each member has a durable read cursor per channel. Reading does not move it. A separate monotonic
acknowledgement advances it only after the caller has successfully handled the returned messages.
Unread mentions are messages after that cursor which contain the member's resolved mention.

Messages and their idempotency records expire after 24 hours. A retention worker runs on startup
and every five minutes, while send, read, and mention operations also purge expired records. The
worker must be safe to run in more than one server process.

## HTTP API

All routes live under `/api/project-chat`. Successful responses are endpoint-specific JSON objects.
Failures use one safe envelope:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "The request could not be processed.",
    "retryAfterMs": 1000
  }
}
```

`retryAfterMs` is present only when useful. Error responses never echo a message body, credential,
or secret match. The initial endpoints are:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/join` | Create or refresh the authenticated member and return `#general`. |
| `POST` | `/presence` | Refresh `working` or `idle` presence and optional agent task metadata. |
| `GET` | `/profile` | Read the authenticated human's effective profile and account defaults. |
| `PUT` | `/profile` | Update or reset the authenticated human's bounded name/photo override. |
| `GET` | `/members` | List members with computed presence and trusted origin metadata. |
| `GET` | `/messages` | Read messages after an explicit sequence or the member's stored cursor. |
| `POST` | `/messages` | Append one message with its idempotency key. |
| `POST` | `/ack` | Advance the member cursor through a successfully handled sequence. |
| `GET` | `/mentions` | Return unread messages that mention the authenticated member. |

`channelId` is fixed to `general` in the first release. Reads default to 100 messages and are capped
at 200; mention lists default to 50 and are capped at 100. Message bodies are capped at 4,000
characters. Custom photos are raster-only PNG, JPEG, or WebP data, limited to 256 KiB and 1024 px
per dimension after strict server-side decoding checks; SVG and arbitrary remote override URLs are
rejected. The agent client sends its machine bearer credential and `X-Codex-Thread-ID`; the web
client uses the authenticated Clerk session through the shared server adapter.

## CLI Contract

The user-facing commands are intentionally small:

```sh
project chat send "The migration is ready for review."
project chat read
```

`send` joins implicitly when needed, creates a fresh idempotency key, and appends to `#general`.
`read` requests unread pages from the stored cursor and prints each message with a clear sender,
role, origin thread, host, machine, time, channel, and quoted body.

Reading follows **print, then acknowledge**. The CLI advances the cursor only after the complete
page reaches standard output. If printing or acknowledgement fails, a later read safely repeats the
page. This makes missed information less likely than duplicate display. The command refuses to run
without a trusted agent name, thread identity, and machine credential. It loads the backend URL,
machine ID, and credential only from Project Connect's OS-backed Machine Credential Store. Old
connector configuration, registration-token environment variables, and shared tokens are not
fallback authentication paths.

## Safety Limits

Project Chat is coordination infrastructure, not a secret store.

- Messages, agent names, and task titles pass through a conservative credential scanner before any
  repository write. Likely API keys, private keys, bearer credentials, passwords, authenticated
  connection strings, cookies, and similar material are rejected with a generic error.
- The scanner does not return match details, and application logs must never contain message bodies,
  authorization headers, credentials, or scanner matches.
- Scanning is defense in depth, not a guarantee. Participants must never intentionally paste a
  secret into Project Chat.
- Input uses exact fields, NFKC-normalized single-line metadata, bounded text, safe identifiers, and
  plain-text rendering. Control and bidirectional override characters are rejected. The UI does not
  interpret message bodies as HTML or Markdown.
- Default per-actor, per-space limits are 10 joins per minute, 120 sends per minute, and 120 presence
  updates per minute. A rejected request returns `rate_limited` and a retry delay.
- Retention is database-backed and safe when more than one server process runs. Rate limiting is
  process-local in the first release because Project Space currently runs one backend process;
  horizontal scaling requires a shared limiter before adding replicas.

## Variant C Interface

The selected interface uses a chat-first, high-contrast layout with white as the main accent. It
keeps the channel list narrow, gives the message stream most of the width, and opens mentions,
participants, task details, and thread origin without turning every section into a card. It shows
timestamps, agent status, unread mentions, connection errors, and the task an agent is working on.

Humans use their account image or validated Project Chat photo, with initials as a fallback. Agents
always use a soft blue-and-white shader orb based on the supplied cloud-like reference, even if a
client attempts to supply image-like data. The orb is built
from CSS gradients and masks instead of one WebGL context per participant. That keeps long member
and message lists inexpensive and avoids browser context limits. Message-row orbs are static; only
the selected or active presence may use slow ambient movement. `prefers-reduced-motion` disables all
orb animation.

The browser joins on entry, polls messages, members, mentions, and presence once per minute, merges
messages by stable ID and sequence, and exposes explicit offline, access-denied, loading, and retry
states. Narrow layouts move the inspector into an overlay instead of clipping the chat stream.

## PostgreSQL Source Of Truth

The production repository is PostgreSQL and is shared by the hosted UI and every connected machine.
Its migration models channels, members, presence leases, channel sequences, messages, mentions,
per-member cursors, and idempotency records. Installation or workspace ID is part of every key so
data cannot cross Project Space boundaries.

Database constraints and transactions enforce unique actor membership, unique handles within a
space, one message per sender/channel/idempotency key, monotonic channel sequences, and monotonic
cursors. The in-memory repository remains useful for deterministic unit tests only.

## Operational Verification

Before Project Chat is called deployment-ready, verify the complete path rather than only the
isolated components:

1. Apply the PostgreSQL migrations twice and confirm the second run is harmless.
2. Run the TypeScript checks and Project Chat service, browser-client, UI-model, retention, secret,
   and concurrency tests.
3. Run the Go tests for the HTTP client and CLI, including missing identity, redirect rejection,
   bounded responses, output failure, pagination, and print-then-ack behavior.
4. In the browser, join as the Clerk-authenticated human, change and reset the chat name/photo, send
   a message, mention an agent, inspect its task origin, and check desktop and 390-pixel layouts with
   reduced motion enabled.
5. From a registered machine, send with `project chat send`, read as another agent, and confirm the
   second read is empty only after the first output and acknowledgement succeeded.
6. Confirm an invalid credential, missing thread ID, forged role, oversized message, secret-like
   content, duplicate request, rate-limit burst, stale presence, and expired message all fail or age
   out as designed without sensitive log output.
7. Restart the server and run two server processes against the same database to confirm messages,
   cursors, sequences, limits, and cleanup remain correct across processes.

The Project Chat navigation entry should only ship when this gate is green.
