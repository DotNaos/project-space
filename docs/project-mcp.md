# ChatGPT Work remote MCP server

Project Space serves an authenticated Streamable HTTP MCP endpoint at `/mcp`. It lets ChatGPT Work discover projects and canonical execution Environments, find and manage GitHub tasks, list and read running Codex tasks, start a task, and send a follow-up message.

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

Connect ChatGPT Work to `https://projects.os-home.net/mcp`, sign in to Project Space, and approve the requested read/write scopes. The remote server uses the same Project Space machine-membership and backend authorization boundaries as the web application. It omits local filesystem paths and embedded image data from MCP results.

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
6. Call `start_codex_task` with the GitHub task number, repository id, and selected `environmentId`. Use `dryRun: true` to validate the open task and target without starting Codex.
7. When one Environment has multiple live connector channels, also pass the exact `connectorId` returned by Environment discovery.
8. Use `list_codex_tasks`, `read_codex_task`, and `send_codex_message` to follow up on the running Codex task. The read and send tools also accept `environmentId`.

An Environment is the canonical execution target. A physical Host is optional, and provider-managed Environments such as GitHub Codespaces never receive a fictional physical machine. Connector records are runtime association evidence rather than Environment identities. `list_machines` remains available as a compatibility projection for older clients.

`update_task` supports title, body, labels, and open/closed state. `add_task_comment` is not idempotent; do not automatically retry it after an unknown network result. Assignees are not exposed because the current Project Space GitHub backend does not support them yet. GitHub is the only task provider currently supported. Azure DevOps is intentionally out of scope for this version.

Preview environments must not be configured as trusted MCP servers. They intentionally do not receive the Clerk secret or production database access.
