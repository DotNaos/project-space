# ChatGPT Work remote MCP server

Project Space serves an authenticated Streamable HTTP MCP endpoint at `/mcp`. It lets ChatGPT Work discover projects and connector machines, list and read Codex tasks, start a task from a GitHub issue, and send a follow-up message.

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

Preview environments must not be configured as trusted MCP servers. They intentionally do not receive the Clerk secret or production database access.
