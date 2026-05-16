# project-space

Project Space is a local-first workspace app for project-centered workflows. One project fills one screen, with project navigation, worktree context, local file browsing, git actions, terminal commands, Codex launch actions, and machine/platform status.

This branch migrates the app to the DotNaos fullstack runtime shape:

- `apps/web`: Bun + Vite + React + Tailwind + HeroUI/DotNaos UI dependencies
- `backend`: Go/Cobra local runtime, CLI, and MCP server
- `desktop/macos`: SwiftPM AppKit shell with WKWebView
- `Dockerfile`: production container for the web app and Go runtime
- `Formula/` and `Casks/`: Homebrew install files
- `.github/workflows`: CI and release pipelines
- `.env.example`, `.env.local`, `.env.op`, `.env.github.example`: local-first config and secret split

The previous TypeScript backend and Electron shell are kept under `legacy-typescript-runtime` and `legacy-electron` while the Go runtime reaches feature parity.

## Commands

- `bun install`
- `bun run dev`
  Starts the Go runtime on `127.0.0.1:4173`.
- `bun run web:dev`
  Starts the web renderer and proxies `/api` to the Go runtime.
- `bun run web:build`
  Builds the web renderer.
- `bun run backend:check`
  Runs Go tests.
- `bun run backend:build`
  Builds the Project Space CLI/runtime binary.
- `bun run desktop:macos:bundle`
  Builds the macOS app bundle.
- `bun run mcp`
  Runs the MCP server over stdio.
- `bun run secrets:doctor`
  Checks local secret tooling without printing secret values.

## Secrets

Real secrets belong in 1Password and are materialized into `.env.op`. Non-secret local config belongs in `.env.local`.

Load order is:

1. `.env.local`
2. `.env.op`
3. process environment

CI reads GitHub Actions secrets only. It does not read directly from 1Password.

## Migration Notes

See [docs/migration-gap-analysis.md](docs/migration-gap-analysis.md) for the gap list and remaining parity work.
