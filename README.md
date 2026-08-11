# Project Space

Project Space is a project-centered workspace for people and coding agents. It
brings repositories, GitHub issues, isolated worktrees, development servers,
pull request previews, connected machines, and Codex tasks into one place.

The web app runs at [projects.os-home.net](https://projects.os-home.net). The
[documentation](https://projects.os-home.net/docs) covers installation,
configuration, and the complete Project CLI reference.

## What is in this repository?

This monorepo contains the Project Space product and the tools that support it:

- the React web and Electron desktop experience;
- the Bun HTTP server, APIs, authentication, and persistence layer;
- the `project` CLI and the connector used by managed machines;
- desktop and mobile prototype surfaces for pull request review;
- the documentation site; and
- release, preview, packaging, and VPS deployment automation.

Project Space models work around projects and tasks instead of treating a
repository as a file explorer. Each coding task gets an isolated Git worktree,
while connectors make local devices, WSL environments, devcontainers, and
GitHub Codespaces available as execution targets.

## Get started

To use Project Space, start with the [setup guide](https://projects.os-home.net/docs/setup).
It explains the supported installation paths for macOS, Linux/WSL, and Windows.
Once installed, create or adopt a project with the CLI:

```sh
project create my-project
cd my-project

# Or initialize an existing repository.
project init
```

Useful next stops are the [CLI reference](https://projects.os-home.net/docs/cli),
[template guide](https://projects.os-home.net/docs/templates), and
[deployment guide](https://projects.os-home.net/docs/deploy).

## Develop Project Space

The repository uses [Bun](https://bun.sh) for JavaScript dependencies and
scripts, plus Go for the Project CLI and native machine tooling.

```sh
git clone https://github.com/DotNaos/project-space.git
cd project-space
bun install --frozen-lockfile
bun run dev
```

The main development commands are:

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the web app through the managed local dev-server flow. |
| `bun run docs:dev` | Start the documentation site. |
| `bun run dev:prototype` | Start the pull request prototype surfaces. |
| `bun run dev:electron` | Run the Electron shell against the local backend. |
| `bun run check` | Check package-manager policy and TypeScript types. |
| `bun run check:cli` | Run the Go test suite. |
| `bun test --isolate` | Run the Bun test suite. |
| `bun run build` | Build all Project Space deliverables. |

Project-managed repositories also describe their supported dev servers in
`.project/scripts.yaml`; the Project CLI and Project Space UI use that contract
to prepare dependencies and launch the right surface.

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | React application, product features, browser API clients, and shared contracts. |
| `server/` | HTTP server, integrations, connector coordination, persistence, and runtime services. |
| `cmd/project/` | Go entry point for the `project` CLI. |
| `internal/` | Go packages shared by the CLI and native machine tools. |
| `electron/` | Electron desktop shell. |
| `apps/docs/` | Documentation website and its MDX content. |
| `apps/prototype/` | Desktop and mobile web prototype surfaces used in pull request previews. |
| `apps/mobile/` | Native mobile prototype app. |
| `docs/` | Detailed architecture, operations, and contributor references. |
| `deploy/` | VPS, preview, database, and connector deployment assets. |
| `packaging/` | Cross-platform release packaging and verification. |
| `tests/` | Integration and contract tests. |

## Learn the systems

- [Project model](docs/project.md) — templates, validation, modules, and the
  interfaces behind the CLI.
- [Compute environments](docs/compute-environments.md) — platforms, hosts,
  environments, connectors, and runner workspaces.
- [Codex worktrees](docs/codex-worktrees.md) — isolated task ownership and the
  managed worktree workflow.
- [Connector guide](docs/connector.md) — connecting machines and running the
  connector lifecycle.
- [Pull request previews](docs/pr-preview-deployments.md) — preview surfaces,
  access, promotion, and cleanup.
- [Project Chat](docs/project-chat.md) — low-priority coordination between
  people and agents.
- [Production deployment](docs/production-deployment.md) — VPS architecture and
  operational verification.
- [Observability](docs/observability.md) — logs, traces, health signals, and
  troubleshooting boundaries.

The generated [local CLI reference](apps/docs/content/docs/cli/index.mdx) and
the hosted docs are the source of truth for commands. Before contributing,
read the repository's `AGENTS.md`; it defines the required worktree, CI,
release-intent, and deployment rules for both people and agents.

## Contributing

Open an issue before substantial work, make changes on a dedicated branch in a
Project-managed worktree, and submit a pull request. Keep changes focused and
run the checks relevant to the paths you touched. A push that creates or updates
a pull request must pass the repository's canonical CI preflight described in
`AGENTS.md`.

Bug reports and feature requests are welcome in
[GitHub Issues](https://github.com/DotNaos/project-space/issues).
