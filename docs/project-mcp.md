# ChatGPT Work remote MCP server

Project Space serves an authenticated Streamable HTTP MCP endpoint at `/mcp`. It lets ChatGPT Work discover projects and connector machines, list and read Codex tasks, start a task from a GitHub issue, and send a follow-up message.

Authentication reuses the production Clerk instance through OAuth 2.1. Enable Clerk's Client ID Metadata Document (CIMD) support and pre-register ChatGPT's client. Enable Dynamic Client Registration only when CIMD is unavailable. Keep PKCE `S256` and the `openid`, `profile`, and `email` scopes enabled.

The production deployment must provide the existing `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. `PROJECT_SPACE_PUBLIC_ORIGIN` must resolve to the public HTTPS origin. `PROJECT_SPACE_ALLOWED_EMAILS`, when present, is enforced for MCP users as well as web sessions.

Discovery endpoints:

- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET`, `POST`, and `DELETE /mcp`

Connect ChatGPT Work to `https://projects.os-home.net/mcp` and complete the Clerk sign-in. The remote server uses the same Project Space machine-membership and backend authorization boundaries as the web application. It omits local filesystem paths and embedded image data from MCP results.

Preview environments must not be configured as trusted MCP servers. They intentionally do not receive the Clerk secret or production database access.
