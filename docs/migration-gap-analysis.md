# Project Space Migration Gap Analysis

## Current State

Project Space was still shaped as an Electron and TypeScript runtime:

- the React app lived at the repository root
- the local backend lived in TypeScript under `server`
- the desktop shell was Electron
- the connector release had a Homebrew formula, but no full app release flow
- there was no Go CLI, no MCP command, no Swift/WKWebView shell, and no Docker image
- local secrets were read directly from process environment without a repo-level `.env.local` and `.env.op` contract
- GitHub Actions were missing for the full app shape

The active checkout also had uncommitted work, so this migration is implemented in its own worktree and branch.

## Implemented Migration

- moved the React app to `apps/web`
- added a Go/Cobra runtime in `backend`
- added `serve`, `health`, `mcp`, and `secrets` CLI commands
- added a SwiftPM macOS shell using WKWebView
- added Docker build support
- added `.env.example`, `.env.github.example`, `.env.local` and `.env.op` loading
- added GitHub CI and release workflows
- replaced the connector-only Homebrew formula with a project runtime formula and cask
- kept the old TypeScript backend and Electron shell under `legacy-*` paths for reference

## Remaining Gaps

- macOS signing can only become real once a valid Apple Developer certificate exists in 1Password
- the Go runtime returns safe placeholder responses for private VPS deploy and backup actions
- project directory selection is canceled in the web runtime until the Swift shell exposes a native dialog bridge
- launcher icons are generic SVG placeholders instead of real macOS app icons
- the old TypeScript runtime should be deleted after feature parity is confirmed
- the release workflow updates assets, but Homebrew SHA replacement is still a release-follow-up step
