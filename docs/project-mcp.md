# ChatGPT Work remote MCP server

Project Space serves an authenticated Streamable HTTP MCP endpoint at `/mcp`. It lets ChatGPT Work discover projects and canonical execution Environments, manage GitHub Codespaces, check and complete managed Codex authorization, find and manage GitHub tasks, list and read running Codex tasks, start a task, and send a follow-up message.

Project Space provides its own OAuth 2.1 authorization server with dynamic client registration, PKCE `S256`, one-hour access tokens, and rotating refresh tokens. ChatGPT registers as a public client, so there is no OAuth client secret to configure. Clerk is used only to authenticate the user in the browser before Project Space displays the consent page.

The production deployment must continue to provide the existing `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` for browser login. No Clerk OAuth Application, CIMD setting, or Clerk Dynamic Client Registration setting is required. `PROJECT_SPACE_PUBLIC_ORIGIN` must resolve to the public HTTPS origin. `PROJECT_SPACE_ALLOWED_EMAILS`, when present, is enforced when consent is granted and whenever a Project Space MCP token is used.

Discovery endpoints:

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET /authorize`
- `POST /token`
- `POST /register`
- `POST /revoke`
- `GET`, `POST`, and `DELETE /mcp`

Connect ChatGPT Work to `https://projects.os-home.net/mcp`, sign in to Project Space, and approve the requested permissions. Environment management, Environment deletion, and agent authorization are separate opt-in permissions and are not granted to new clients by default. The remote server uses the same Project Space machine-membership and backend authorization boundaries as the web application. It omits local filesystem paths, embedded image data, account details, and credentials from MCP results.

Connect Codex with:

```sh
codex mcp add project-space --url https://projects.os-home.net/mcp
```

Codex opens the same Project Space authorization flow and returns to the local app through a loopback callback after approval.

The GitHub-first task flow is:

1. Call `list_projects` and select an authorized repository.
2. Call `list_tasks` with that repository id to find open GitHub tasks. Use `get_task` for one task's details.
3. Use `create_task`, `update_task`, and `add_task_comment` for GitHub task changes. `create_task` requires a UUID `operationId`; reuse it only to safely retry the same draft.
4. Use `get_task_status` to inspect linked branches, pull requests, and workflow runs.
5. Call `list_execution_environments` to discover the available execution targets. Use `get_execution_environment` with one exact `environmentId` to inspect its optional Host, connector associations, runtime capabilities, resources, and readiness.
6. Call `get_agent_status` with the selected `environmentId` and `agent: "codex"`. If authorization is required, call `start_agent_authorization` with a stable `operationId`, show its short-lived user code and verification URL to the user, then poll `get_agent_authorization` with that same operation ID. `cancel_agent_authorization` cancels only that exact attempt.
7. Call `start_codex_task` with the GitHub task number, repository id, and selected `environmentId`. Use `dryRun: true` to validate the open task and target without starting Codex.
8. When one Environment has multiple live connector channels, also pass the exact `connectorId` returned by Environment discovery.
9. Use `list_codex_tasks`, `read_codex_task`, and `send_codex_message` to follow up on the running Codex task. The read and send tools also accept `environmentId`. Supply a stable caller-generated `operationId` when sending so the same request can be retried safely.

## Sending, steering, and queueing messages

`send_codex_message` and its Task Execution equivalent, `send_task_execution_message`, accept `mode: "auto" | "steer" | "queue"`. The default is `auto`.

- `auto` reads the same authoritative session state used by `read_codex_task`. It starts a new turn only when the session is verified as idle. If a turn is active, it returns a genuine `blocked` result instead of guessing whether to steer or queue.
- `steer` sends the message to the currently active turn. It requires `expectedTurnId`, copied from the latest verified read. If that exact turn is no longer active when the send reaches the connector, the result is `blocked` with reason `turn_changed`.
- `queue` stores the message durably behind earlier queued messages for the same Codex task. When a turn is active, it returns `queued` immediately and dispatches the messages in first-in, first-out order as the session becomes idle. If the session is already idle, the message can be sent immediately and returns `sent`.

Always generate one stable `operationId` for the logical message and reuse that value only when retrying the identical request. A retry with the same ID and content returns the recorded result; changing the message, mode, target, or expected turn while reusing the ID is a conflict.

Without `wait`, an immediate delivery returns `sent` or `steered` as soon as the connector accepts it. With `wait: true`, an immediate send or steer waits for that turn to finish and returns `completed`; the `delivery` field still records whether it was `sent` or `steered`. Approval or input requests return `blocked`, and an outcome that cannot be reconciled safely returns `uncertain`. Queue acceptance behind active or earlier work returns `queued` immediately, even when `wait` is requested. If no work is ahead and the task is already idle, queue mode dispatches immediately and honors `wait` like a normal send.

Task Execution responses also include `messageOutcome`. It records the message result and any blocked reason even when the surrounding execution correctly remains `running`, and the same outcome is returned when an identical `operationId` is replayed.

These modes do not change targeting or authorization. `send_codex_message` still resolves the exact authorized Environment and connector selected by `environmentId`, `connectorId`, or the supported physical-machine selectors, and `send_task_execution_message` remains bound to its exact Task Execution. Neither tool can use steering or queueing to bypass Project Space membership, machine ownership, connector generation, or write-scope checks.

An Environment is the canonical execution target. A physical Host is optional, and provider-managed Environments such as GitHub Codespaces never receive a fictional physical machine. Connector records are runtime association evidence rather than Environment identities. `list_machines` remains available as a compatibility projection for older clients.

Managed Codex authorization accepts only a current ChatGPT subscription account confirmed through a fresh connector account check. API keys and stale readiness flags are not accepted. Project Space stores only the attempt identity, target, connector evidence, deadline, and safe state needed for replay and recovery; device codes, connector login identifiers, account details, and tokens are never stored in the hosted operation ledger.

`update_task` supports title, body, labels, and open/closed state. `add_task_comment` is not idempotent; do not automatically retry it after an unknown network result. Assignees are not exposed because the current Project Space GitHub backend does not support them yet. GitHub is the only task provider currently supported. Azure DevOps is intentionally out of scope for this version.

Preview environments must not be configured as trusted MCP servers. They intentionally do not receive the Clerk secret or production database access.
