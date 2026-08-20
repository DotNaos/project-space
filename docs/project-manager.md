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

Normal authentication checks, CI and Preview gates, protected gates, signing,
compatibility, merge, release, and Production delivery remain Manager-owned
technical work under standing authorization. Only a material product decision,
exceptional irreversible, external, or privacy risk, or a human-only blocker is
escalated.

Implementation dispatch uses the canonical #763 operation
`project codex start --issue <n> --environment-id <id> --operation-id <id> --format json`,
which owns issue-bound preparation and returns the worker task. The landed #763
contract was reviewed at `7e0e321f63e0d3bde8a862b936cda821b25951d2` and
squash-merged to main as `b92d411c995d605358dd8c05c80362e80f6bbdd0`. It
carries auditable model/reasoning and reporting-task fields, but the server
labels its reporting evidence `caller-supplied`; it does not authenticate a
Manager. Before dispatch, the local caller gate proves `state=main`,
`role=project-manager`, `mutatingAllowed=false`, and the current
`CODEX_THREAD_ID` match. No caller supplied role or thread alternative is
accepted. The stacked dependency is reconciled; remaining draft and delivery
gates belong to the Manager.

Every 30 minutes the Manager reconciles active worker state. Idle, interrupted,
failed, timed-out, and completed turns are events to repair or advance, not
blockers. Only a genuine human-in-the-loop decision, exceptional risk, or
human-only blocker stops the critical path. `TASKS.md` is maintained from the
skill template and checked by its validator; it records assumptions, review and
Preview evidence, and delivered-state proof.

Before each implementation dispatch and every heartbeat, the Manager searches
open issues, known-issues/bug labels, and equivalent Production incident records
for defects affecting the feature's runtime, Preview, delivery, authentication,
transport, data, CI, or deployment path. Existing evidence is linked and
promoted rather than duplicated; a focused bug is filed only when no issue
captures it. A reproduced blocker is added to `TASKS.md` with its blocked stage,
dependency edge, evidence, severity, owner, queue position, and shortest
recovery path. Nonblocking bugs remain parallel. After fixing one, the Manager
verifies the actual Production path, relaxes the edge with evidence, and resumes
the dependent worker.
