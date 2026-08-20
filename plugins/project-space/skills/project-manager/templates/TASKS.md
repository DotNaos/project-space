# Project Manager Task Ledger

The Project Manager owns this ledger. Keep one row per implementation issue and
never exceed three `active` implementation rows in addition to the Manager.

## Critical path

- Current decision or dependency:
- Next Manager action:
- Last heartbeat (UTC):

## Workers

| issue | worker task | Project/environment | branch/worktree | operation | model/reasoning | state | assumptions | reviewed commit | PR/checks | Preview or alternative proof | delivery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #000 | `<thread-id>` | `<Project>/<environment-id>` | `<branch>; <Project-managed path>` | `<operation-id>` | `gpt-5.6-luna/high` | `queued` | `<explicit contract>` | `<sha or pending>` | `<PR and CI>` | `<exact-head Preview/browser proof or recorded no Preview>` | `<pending>` |

## Escalations

Only genuine human-in-the-loop decisions belong here. Each entry must include
the exact question, mutually exclusive options, recommendation, risk, worker
task, revision, and safe work that continues meanwhile.

## Completion checklist

- [ ] Exact PR head and complete diff reviewed.
- [ ] Unresolved review feedback and required CI inspected.
- [ ] Exact-head Preview dogfooded at desktop/mobile primary and critical edge paths, or no Preview-compatible surface recorded with the strongest alternative proof.
- [ ] Concrete feedback returned to the same worker and review loop is clean.
- [ ] PR approved/readied and normal merge/delivery completed.
- [ ] Delivered commit, health, and reachable origin verified.
