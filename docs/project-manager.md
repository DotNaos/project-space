# Project Manager workflow

Project Space routes agents by proven checkout context. Run
`project worktree context --format json` before deciding what the task may do:

| context | role | mutation |
| --- | --- | --- |
| `main` | Project Manager | read-only |
| `owned` | issue worker | allowed in its owned Project-managed worktree |
| `foreign` | observer | read-only |
| `unmanaged` | observer | read-only |

The versioned workflow lives in
`plugins/project-space/skills/project-manager/SKILL.md`. It routes each
implementation to an issue-bound worktree, defaults to `gpt-5.6-luna` with high
reasoning, reuses the same worker for review corrections, and caps active
implementation workers at three. Work may be developed against explicit
assumptions before a dependency lands, but integration, review, rebase, merge,
and delivery reconcile the exact landed dependency in order.

The Manager is the sole user communicator and owns completion. A worker-ready
PR is not completion: the Manager reviews the exact head, unresolved feedback,
CI, and realistic user flow. When a supported Preview exists, the Manager
obtains the exact-head Preview and dogfoods it through the browser at desktop and mobile sizes on primary and critical edge paths. Review defects return to
the same worker until clean, after which the Manager readies the PR and completes
normal delivery. If no Preview-compatible surface exists, the Manager records
that fact and uses the strongest realistic alternative proof.

Every 30 minutes the Manager reconciles active worker state. Idle, interrupted,
failed, timed-out, and completed turns are events to repair or advance, not
blockers. Only a genuine human-in-the-loop decision, exceptional risk, or
human-only blocker stops the critical path. `TASKS.md` is maintained from the
skill template and checked by its validator; it records assumptions, review and
Preview evidence, and delivered-state proof.
