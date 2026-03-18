# project-space

`project-space` is a desktop-first project workspace, not a file explorer IDE. One project fills one screen. The left side of the app is a workflow explorer for project structure, and the app later launches external tools like IDE, terminal, git, and dev server from task or worktree context.

The repository currently targets a reduced MVP:

- Electron + React + TypeScript + Vite scaffold
- TailwindCSS setup
- clean separation between Electron `main`, `preload`, and renderer
- typed domain model for projects, worktrees, issue docs, runtime sessions, integration requests, and edit transfer concepts
- a single-project desktop shell with a workflow explorer and placeholder launch actions
- product docs for vision, brain dump, and current MVP scope

## Stack

- Electron
- React
- TypeScript
- Vite
- TailwindCSS

## Scripts

- `npm install`
- `npm run dev`
- `npm run build`
- `npm run check`

## Structure

- `electron/main`
  Electron main process entry and IPC placeholders.
- `electron/preload`
  Preload bridge exposed to the renderer.
- `src/domain`
  Core domain types only. No persistence or integrations yet.
- `src/application/ports`
  Future-facing interfaces for launchers, runtimes, issue docs, transfer flow, and conflict validation.
- `src/infrastructure/stubs`
  Thin placeholder implementations used by iteration 1.
- `src/features/project-desktop`
  Mock data, view state, and the initial desktop shell UI.
- `.dev`
  Product vision, brain dump, and scoped planning notes.

## Documentation

- `.dev/product.md`
- `.dev/vision.md`
- `.dev/scope/iteration-1.md`

## Current MVP Boundaries

Included now:

- desktop app foundation
- single-project desktop shell
- workflow explorer tree
- issue doc placeholders
- mock navigation and action flows

Explicitly deferred:

- multi-project support
- real git integration
- real worktree discovery
- markdown persistence
- hunk diff parsing or patch application
- runtime orchestration
- IDE, terminal, git, or dev server launching
- backend, database, auth, or AI features

## Product Direction

- One project per screen
- Workflow explorer instead of filesystem browsing
- Hierarchy: Project -> Sprint -> Feature -> Task -> Worktree -> Issue docs
- External tools launch from task and worktree context
- Local integration into iteration branches comes later
- Edit transfer and conflict preflight validation come later
