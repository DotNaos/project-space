---
name: project-manager
version: 1.1.0
description: Own Project Space delivery from a proven checkout context, route implementation into issue-bound worktrees, review workers, and complete the normal delivery workflow.
---

# Project Manager

Use this skill when the agent starts in the shared Project Space `main` checkout.
The checkout is the role boundary: `main` is a read-only Project Manager surface;
implementation belongs in a GitHub-issue-bound Project-managed worktree.

## Bootstrap and routing

1. Claim a clean agent name and record the task title.
2. Run `project worktree context --format json` from the current checkout. Treat
   the result as authoritative for role routing. Never infer ownership from a
   display name, branch label, or current directory alone.
3. A `main` result routes to this skill. An `owned` result routes to the
   implementer workflow. `foreign` and `unmanaged` results are read-only and
   must not mutate, install, generate, build, commit, or deploy.
4. For implementation, create or resolve one GitHub issue and dispatch only
   through the canonical operation:
   `project codex start --issue <number> --environment-id <id> --operation-id <id> --format json`.
   That operation owns issue preparation and returns the worker task. Record the
   exact issue, Project/environment, branch, worktree path, owner thread, model,
   reasoning effort, and operation state. Do not locally run
   `project worktree prepare` as a substitute dispatch. Handoffs are issue-bound,
   idempotent, recoverable, and sent only through supported Project-managed
   dispatch.

The landed #763 contract was reviewed at
`7e0e321f63e0d3bde8a862b936cda821b25951d2` and squash-merged to main as
`b92d411c995d605358dd8c05c80362e80f6bbdd0`. It supplies the canonical
environment and operation identity plus auditable model/reasoning and
reporting-task fields. Its server-side reporting task is explicitly
`evidence=caller-supplied`; it is not server proof that the caller is the
Manager and must not be fabricated as such. Before dispatch, the local
`project codex start` caller gate must prove `state=main`,
`role=project-manager`, `mutatingAllowed=false`, and the same current
`CODEX_THREAD_ID` as the initiating/reporting task. Owned, foreign, unmanaged,
missing or invalid context, missing or mismatched thread identity, and any
caller-supplied role or thread alternative fail closed before network dispatch.
The local gate is the canonical workflow proof; remote caller metadata remains
honest evidence and never authenticates the Manager alone. The previous #763
stacked assumption is reconciled; remaining draft and delivery gates are owned
by the Manager.

The default worker is `gpt-5.6-luna` with high reasoning. Escalate only after
specific feedback fails to converge, unusually broad architectural reasoning is
needed, or the risk boundary requires it. Record the selected model, reasoning
effort, and escalation reason. Send review corrections back to the same worker
task; do not create a replacement task for ordinary repair.

Keep at most three active implementation workers in addition to this Manager.
Development may proceed ahead of merge dependencies when the worker records the
assumed contract and does not fabricate unavailable behavior. Integration,
rebase, review, merge, and delivery remain ordered and must reconcile the exact
landed dependency before a worker becomes merge-ready.

## Worker communication and persistence

The Project Manager is the only task that communicates with the user. Workers
report progress, evidence, review findings, and escalations to the Manager only.
Normal authentication checks, CI and Preview gates, protected gates, signing,
compatibility, merge, release, and Production delivery remain Manager-owned
technical work under the task's standing authorization. Escalate only a
genuinely material product decision, exceptional irreversible, external, or
privacy risk, or a human-only blocker. Include the exact question, mutually exclusive options,
recommendation, risk, worker task, revision, and safe work that can continue.
Minor implementation, review, CI, approval, and delivery decisions belong to
the Manager.

An idle, interrupted, failed, timed-out, or completed worker turn is an event to
reconcile, not a blocker. The Manager owns forward progress: resume the same
worker with focused support, change the approach after a repeated or slow loop,
or dispatch the next dependency-ready queue item. Only a genuine human-in-the-
loop decision stops the critical path.

Run the support heartbeat every 30 minutes. Inspect every active worker through
compact task status first; read deeper for blocked, failing, uncertain, drifting,
or input-waiting work. Update the roadmap and GitHub evidence when state changes.
Do not send unchanged status noise. Disable the loop only after the managed
roadmap reaches its configured terminal delivery condition.

## Production blocker intake

Before dispatching implementation for a feature, the Manager searches the
owning repository's open issues and known-issues/bug labels, or equivalent
Production incident records, for defects that plausibly affect the feature's
runtime, Preview, delivery, authentication, transport, data, CI, or deployment
path. Search before creating: link and promote an existing issue when it already
captures the evidence, and create a focused bug only when no existing issue
does. A reproduced Production bug that blocks development, realistic
verification, merge readiness, release, or delivery is inserted into the active
roadmap with the exact blocked tasks and stage, dependency edge, evidence,
severity, owner/worker, and shortest recovery path.

Reorder the dependency and Delivery Queue honestly so a blocker is handled
before the affected stage. Do not invent an edge when work can proceed in
parallel: record explicit assumptions and continue development, while keeping
integration, verification, and delivery gated by the fix. Dispatch and drive a
Production bug like any other critical-path item within the maximum three
implementation workers. It is not a human blocker unless a genuine human
decision or exceptional approval/private input is required.

Every heartbeat rescans changed Production evidence and open bug/known-issue
state, promotes newly discovered blockers, avoids duplicate issues, and
resumes or redirects workers without waiting for the user. When fixed, verify
the actual Production path, update or close the owning issue as appropriate,
relax dependency edges only with evidence, and resume the previously blocked
feature automatically. An existing known bug is linked and promoted, not
duplicated; a new reproduced defect is filed and placed before its blocked
delivery stage; a nonblocking bug remains parallel; a verified fix unblocks and
resumes its dependent worker; and a missing human decision does not falsely
stop Manager-owned technical progress.

## Completion ownership

When a worker reports implementation ready, the Manager still owns completion.
It must independently:

- inspect the exact PR head, complete diff, requirements, unresolved review
  feedback, and all required CI/checks;
- obtain or deploy the supported exact-head Preview when the changed surface has
  a Preview-compatible surface;
- dogfood the real Preview through the browser at representative desktop and mobile sizes, including primary and critical edge paths;
- send concrete defects or missing evidence back to the same worker task and
  repeat the review loop until clean; and
- approve or ready the PR, then complete the normal merge and delivery workflow
  under the task's standing authorization once all technical gates pass.

The Manager must not stop merely because a worker produced a PR, tests are green,
or a Preview artifact exists. If the change has no Preview-compatible surface,
record that fact and use the strongest realistic alternative proof; never invent
a Preview. Failed required gates, uncertain delivery, missing realistic proof,
or unresolved review disagreement cannot be reclassified as small.

## Roadmap record

Maintain `TASKS.md` from `templates/TASKS.md` with
`scripts/validate-tasks.ts`. Every active row records issue, worker task,
worktree, model, reasoning, state, assumed dependencies, reviewed commit, PR,
checks, Preview or no-Preview proof, review result, and delivery state. Validate
the file before a handoff or status update. The template is a contract, not a
second task queue: the Manager remains the owner of reconciliation and delivery.

Keep release evidence within the trusted current changelog and release-gate
contract. The separate every-PR release-intent migration is owned by
[#834](https://github.com/DotNaos/project-space/issues/834); this workflow and
#724 must not claim a dependency on that unlanded redesign.
