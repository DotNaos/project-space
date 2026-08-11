# project-space

`project-space` is a desktop-first project workspace, not a file explorer IDE. One project fills one screen. The left side of the app is a workflow explorer for project structure, and the app later launches external tools like IDE, terminal, git, and dev server from task or worktree context.

The repository currently targets a web-first fullstack MVP:

- React + TypeScript + Vite frontend
- HTTP backend for local project discovery, filesystem reads, launcher apps, and persisted UI state
- local terminal command execution for the selected workspace or worktree
- git status, diff, stage, unstage, and commit actions for the selected target
- Codex CLI/app status and open-target support
- browser-hosted frontend that talks to the backend over HTTP
- TailwindCSS setup
- typed domain model for projects, worktrees, issue docs, runtime sessions, integration requests, and edit transfer concepts
- a single-project workspace UI with a workflow explorer and placeholder launch actions
- product docs for vision, brain dump, and current MVP scope

## Stack

- React
- TypeScript
- Vite
- TailwindCSS
- Bun for the local production-style web server

## Project commands

- `project prepare`
- `project serve`
  Run the complete app with simulated provider APIs and isolated local data. This is the default development profile and needs no hosted database, provider account, API key, or 1Password secret.
- `project serve --apis external --data local`
  Reserved for real integrations with isolated local data. Startup currently fails closed until secure detached service-account delivery is available.
- `project serve --apis external --data remote`
  Reserved for real integrations with the configured shared database. Startup currently fails closed, and this profile must never migrate, seed, or reset remote data automatically.
- `project serve dev --local-only`
  Compatibility spelling for the default local-only transport.
- `project serve --tailnet`
  Reserved explicit Tailscale publication control. Simulated APIs remain loopback-only until local owner authentication is available, and external APIs remain blocked until secure credential delivery is implemented.
- `project run build`
  Build the deployable web frontend.
- `project run check`
  Type-check the app.
- `project run test`
  Run the test suite.

The installed `project`, `portless`, `tmux`, and `lsof` commands are required
for the normal local development-server path. The `tailscale` command is only
needed when the separate `--tailnet` transport is enabled.

## Structure

- `server`
  HTTP routing and local backend services.
- `src/api`
  Browser-side HTTP client for the backend.
- `src/shared`
  Shared frontend/backend API types.
- `src/domain`
  Core domain types.
- `src/application/ports`
  Future-facing interfaces for launchers, runtimes, issue docs, transfer flow, and conflict validation.
- `src/infrastructure/stubs`
  Thin placeholder implementations used by iteration 1.
- `src/features/project-desktop`
  Mock data, view state, and the initial project workspace UI.
- `.dev`
  Product vision, brain dump, and scoped planning notes.

## Documentation

- [Hosted Project documentation](https://projects.os-home.net/docs)
- [Project Space Codex plugin](docs/codex-plugin.md)
- [Generated CLI command reference](apps/docs/content/docs/cli/index.mdx)
- [CLI self-update guide](apps/docs/content/docs/cli/self-update.mdx)
- [Connector install and usage guide](docs/connector.md)
- [Linux and WSL installation guide](docs/linux-installation.md)
- [Windows installation guide](docs/windows-installation.md)
- `.dev/product.md`
- `.dev/vision.md`
- `.dev/scope/iteration-1.md`

## Current MVP Boundaries

Included now:

- browser-hosted app foundation
- single-project workspace UI
- workflow explorer tree
- issue doc placeholders
- project discovery under `~/projects`
- git worktree discovery
- local filesystem reads for the file sidebar
- launcher app discovery and open-path actions
- terminal panel for local commands
- git changes panel with status, diff, stage, unstage, and commit
- Codex panel for local Codex app/CLI detection and opening the active target
- UI state persisted in `~/.project-space/projects.json`

Explicitly deferred:

- markdown persistence
- hunk diff parsing or patch application
- runtime orchestration
- hosted database, auth, or AI features
- hosted backend adapters for non-local deployments
- full interactive PTY streaming terminal

## Product Direction

- One project per screen
- Workflow explorer instead of filesystem browsing
- Hierarchy: Project -> Sprint -> Feature -> Task -> Worktree -> Issue docs
- External tools launch from task and worktree context
- Local integration into iteration branches comes later
- Edit transfer and conflict preflight validation come later
