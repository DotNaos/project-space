# Current MVP Scope

This file describes the reduced MVP target for the current phase.

This iteration maps to version line `0.1.x` under `.dev/versioning.md`.

## Goals

- keep exactly one project on screen
- remove fake multi-project interaction
- keep the workflow explorer as the main navigation surface
- show the selected task and worktree context
- keep issue docs visible as a first-class placeholder
- keep launcher actions visible, but still placeholder-only

## Included In The MVP

- Electron `main`, `preload`, and renderer separation
- typed domain model for project workflow and future extension points
- single-project mock data for `project-space`
- workflow explorer with Project -> Sprint -> Feature -> Task hierarchy
- minimal detail view for the selected workflow node
- worktree branch context
- issue document placeholder
- quick action buttons for IDE, Terminal, Git, and Dev Server

## Removed From The UI For Now

- multi-project switcher
- fake second project
- runtime session panel
- integration flow panel
- extra placeholder surfaces that do not help the core MVP

## Still Out Of Scope

- real git integration
- real worktree discovery
- real markdown persistence
- real launcher behavior
- runtime orchestration
- edit transfer and hunk parsing
- conflict preflight validation
- backend, database, auth, and AI features

## Exit Criteria

- the app boots as a single-project desktop shell
- the left side is a workflow explorer
- the right side shows the selected node, worktree context, issue doc placeholder, and actions
- the docs clearly separate long-term vision from the reduced MVP
