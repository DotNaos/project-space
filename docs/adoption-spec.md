# Adoption Spec — migrating existing repos onto the project template

Behavioral spec for `project adopt` and the adoption UI. Normative for
[control-plane-plan.md](control-plane-plan.md) Phase B (engine/CLI) and
Phase D (web UI): those phases implement *this* model.

## Core idea

Migration is **iterative denoising toward the template tree**, resolved
**top-down, divide-and-conquer, subtree-at-a-time** — never a big-bang
rewrite. `project init` attaches metadata without touching any project file;
from then on every file is in exactly one classification state, and each
adoption step converts some states into "resolved" states. Done = no
unresolved states left. Every intermediate state is a valid, runnable repo.

## File state model

Every file in the project is in exactly one state:

| State | Meaning | Resolved? |
|---|---|---|
| `match` | byte-equal to the rendered template file | ✅ |
| `slot` | inside an allowed extension area (`.slot.yaml`) | ✅ |
| `waived` | kept deliberately; recorded in the lock with a reason | ✅ (tracked debt) |
| `missing` | template file the project doesn't have yet | ⬜ |
| `drift` | template-owned path exists, content differs | 🟡 |
| `unknown` | no template counterpart, no slot, no waiver | 🔴 |
| `blocker` | `unknown` matching a blocker rule (see below) | ⛔ not waivable |

**Blocker rules** are template-defined patterns for files that must never be
carried over or waived — first entry: plaintext secret files (`.env`,
`.env.local` with non-`op://` values). Declared in the template module YAML
(`blockers:` list of glob + reason), enforced by classifier and validate.

Blocker detection runs before slot or waiver pruning. A slotted or waived
subtree may be skipped for normal adoption noise, but it must not hide a
blocker file; blocker patterns are checked globally and always win.

## Hierarchical rollup

Directories aggregate their subtree: a directory's state is the *worst* state
beneath it, and rollup counts (`48 match · 43 slot · 2 waived · 5 unknown`)
propagate to the root. The root rollup is the project's "noise level" — the
single number the frontend shows per project and the burn-down metric over
time.

## Resolution algorithm (top-down, divide and conquer)

```
resolve(dir):
  for each entry in dir (layer N):
    template-owned file      -> adopt (write) / take / merge     [STOP]
    template-owned scaffold  -> adopt scaffold, RECURSE (layer N+1)
    fits a slot              -> done                             [STOP, prune subtree]
    waive                    -> record reason                    [STOP, prune subtree]
    superseded               -> delete (backed up)               [STOP]
    movable                  -> git mv into slot/owned area      [STOP or RECURSE at target]
    blocker                  -> must be fixed, cannot prune      [BLOCK]
```

Properties the implementation must preserve:

1. **Layer 1 dominates.** Deciding the top-level entries settles most files,
   because slot/waive/mv decisions resolve entire subtrees at once. Recursion
   happens only where the template owns structure *inside* a directory.
2. **Pruning:** once a subtree is slot or waived, the classifier and validator
   never descend into it for normal adoption noise. Blocker scanning is the
   exception: blocker patterns are checked before pruning, so a resolved subtree
   cannot hide a non-waivable file. Work is proportional to the boundary between
   template-owned and project-owned regions, not to file count.
3. **Branch independence:** resolving `deploy/` must not depend on `src/`
   having moved. Each decision is separately committable; adoption can pause
   indefinitely at any point with validation still meaningful (green above the
   resolved frontier, informational below it).

## CLI surface

```sh
project init <dir>                       # attach metadata only (.project/); never
                                         # touches project files, even when dir is non-empty
project adopt [dir] --dry-run            # classify; default when no action flag given
project adopt --module <name> [--yes]    # write that module's missing files;
                                         # drift files untouched but recorded
project adopt --take <path>...           # replace file(s) with rendered template;
                                         # originals saved to .project/adopt-backup/<date>/
project adopt --merge <path>             # guided structured merge (files with rules,
                                         # e.g. package.json): template as base, project
                                         # extras carried into allowed slots, frozen
                                         # conflicts listed for decision
project adopt --waive <glob> --reason <text>
project adopt --unwaive <glob>
project adopt --move <from> <to>         # classifier-suggested git mv, applied
```

All of these: plan → confirm → apply (`--yes` skips prompt, `--dry-run` never
writes), `--format json`, non-TTY fails fast per control-plane Phase A.

### Classification output (dry-run)

Per-module rollups plus a suggestions section. The classifier suggests moves
via heuristics (e.g. `index.html` + `vite.config.ts` at root → suggest
`--move` into `clients/web/`), never applies them.

```
Adoption plan — food-tracker on project-template@0.1.0

Module core.fullstack        NOT ADOPTED
  missing  38  deploy/**, scripts/**, .github/**, clients/web/** ...
  drift     3  package.json, .gitignore, README.md
  match     1  tsconfig.base.json

Unknown
  src/** (41), index.html, vite.config.ts   suggest: --move . clients/web
  api/** (12)                               no template home (waive or new module)
  deploy.sh                                 superseded by deploy/ module
Blockers
  .env                                      plaintext secrets -> migrate to
                                            .env.secrets (op:// refs), delete
```

## Lock schema additions (`.project/template.lock.yaml`)

```yaml
adopted: [core.fullstack]          # modules active for validation
waivers:
  - path: api/**
    reason: Bun backend; pending backend.bun template module
    added: 2026-07-02
```

## Validation integration

- `project validate` scopes to `adopted` modules. Files owned by un-adopted
  modules → status `NOT_ADOPTED` (informational). Waived files → `WAIVED`
  (informational). Blockers → `VIOLATION` regardless of waivers.
- `Report` gains `Modules []ModuleAdoption` (name, adopted, per-state counts)
  and per-entry rollups for directories, so the frontend tree view and the
  CLI print from the same JSON.
- Overall `OK` = every file is `match | slot | waived` and no blockers.

## Safety rails

- No mutation without a shown plan; web UI confirms against a plan hash
  (control-plane Phase D re-plan check).
- Anything overwritten or deleted is copied to
  `.project/adopt-backup/<date>/` first.
- Idempotent and resumable: all state lives in the lock + working tree;
  re-running `adopt --dry-run` after any interruption yields the current
  frontier.
- One decision = one commit (the CLI prints a suggested commit message per
  applied action; it does not auto-commit).

## Waiver burn-down

Waivers are visible debt, not exceptions: listed by `validate`, shown in the
frontend per project, counted in the fleet overview. The intended resolution
path for structural waivers is **growing the template** (e.g. `api/**` waiver
retires when a `backend.bun` module exists and is adopted), not forcing the
project. `adopt --unwaive` + module adopt is that conversion.

## Reference migration & acceptance

Project Space itself is the reference case (control-plane Phase B task 4):
init + adopt ops-layer files (deploy/**, scripts/, .env.secrets), `--move`
the root Vite app under `clients/web/`, waive `server/` (TS backend) and
`electron/` with reasons, delete legacy root metadata and the projectctl
bridge. Acceptance:

1. `adopt --dry-run --format json` on a fixture repo classifies every file
   into exactly one state, with correct directory rollups and suggestions.
2. Slot/waive pruning: classifier provably does not descend into pruned
   subtrees (test with an unreadable nested dir).
3. Each CLI action above has a fixture test: plan shown, nothing written on
   decline, backup created on take/delete, lock updated on waive/module.
4. A blocker file cannot be waived (`--waive .env` fails with the reason).
5. Full walkthrough on the food-tracker-shaped fixture ends with
   `validate` OK: `match + slot + waived` only, and works when the stages are
   executed in a different branch order (branch independence).
