# Vision

`project-space` is a project desktop for operating one software project at a time.

It is not a file explorer IDE. The primary navigation is the workflow structure of the project:

- Project
- Sprint
- Feature
- Task
- Worktree
- Issue documents

The left side of the app is always the workflow explorer. The main panel reflects the selected workflow node and the active worktree context.

The application later launches external tools from that context:

- IDE
- Terminal
- Git
- Dev Server

The important product direction stays the same:

- one project per screen
- local-first workflow
- issue markdown per worktree
- later support for integration, transfer, and conflict validation

The MVP should deliberately show less, not more. It should prove the core structure before any real integrations are added.
