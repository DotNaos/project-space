# project-space

`project-space` is a desktop-first project workspace, not a file explorer IDE. One project fills one screen. The left side of the app is a workflow explorer for project structure, and the app later launches external tools like IDE, terminal, git, and dev server from task or worktree context.

The repository currently targets a web-first fullstack MVP:

- React + TypeScript + Vite frontend
- HTTP backend for local project discovery, filesystem reads, launcher apps, and persisted UI state
- local terminal command execution for the selected workspace or worktree
- git status, diff, stage, unstage, and commit actions for the selected target
- Codex CLI/app status and open-target support
- Electron shell that hosts the same frontend and talks to the backend over HTTP
- TailwindCSS setup
- no renderer IPC contract or Electron preload bridge
- typed domain model for projects, worktrees, issue docs, runtime sessions, integration requests, and edit transfer concepts
- a single-project desktop shell with a workflow explorer and placeholder launch actions
- product docs for vision, brain dump, and current MVP scope

## Stack

- Electron
- React
- TypeScript
- Vite
- TailwindCSS
- Bun for the local production-style web server

## Scripts

- `pnpm install`
- `pnpm dev`
  Run the web app in fullstack development mode.
- `pnpm build`
  Build the deployable web frontend.
- `pnpm start`
  Serve the built frontend plus backend from one local HTTP server.
- `pnpm dev:electron`
  Run the Electron shell against the HTTP backend.
- `pnpm build:electron`
  Build the web frontend and Electron main process.
- `pnpm check`
  Type-check the app.

## Structure

- `electron/main`
  Electron main process entry. It starts the local backend and loads the web frontend.
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
  Mock data, view state, and the initial desktop shell UI.
- `.dev`
  Product vision, brain dump, and scoped planning notes.

## Documentation

- [Connector install and usage guide](docs/connector.md)
- `.dev/product.md`
- `.dev/vision.md`
- `.dev/scope/iteration-1.md`

## Current MVP Boundaries

Included now:

- desktop app foundation
- single-project desktop shell
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
