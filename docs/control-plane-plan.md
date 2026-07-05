# Project Space Control Plane Plan

Implementation plan for turning Project Space into the control plane over all
projects: discover repos, initialize/adopt them against the project template
from the web UI, view template validation, observe deployments and
environments, and drive GitHub workflows.

Companion to [template-engine-refactor-plan.md](template-engine-refactor-plan.md)
(engine internals). This plan is independent of that one except where noted;
the two can proceed in parallel. Shared principle: **the `project` CLI is the
only API to template/deploy state — the Project Space server shells out to it
and never reimplements engine logic in TypeScript.**

## Current state (baseline)

- The server already bridges to the CLI:
  [server/local-project-cli-client.ts](../server/local-project-cli-client.ts)
  spawns `bin/project` (fallback: `project` on PATH) for `validate`,
  `module list/show`, `template sync --dry-run`, `template update --dry-run`,
  `deploy status`, parsing pretty/TSV text.
- Shared request/response types live in
  [src/shared/project-space-api.ts](../src/shared/project-space-api.ts)
  (`ProjectCliCommand`, `ProjectCliCommandRequest/Result`, line ~418).
- A dead bridge to the previous-generation tool exists:
  [server/local-projectctl-client.ts](../server/local-projectctl-client.ts)
  probes `projectctl`, `/tmp/projectctl-json`, `~/.local/bin/projectctl`.
- Project Space itself carries legacy metadata from that previous generation:
  root [project.yaml](../project.yaml) and [template.lock.yaml](../template.lock.yaml)
  (`lockVersion: 2`, presets/addons/platform statuses). The current CLI uses
  `.project/template.lock.yaml` instead. Two generations, one repo.
- Deployment: template-owned `deploy/` (compose.yml, ingress.labels.yml,
  deploy.yaml) targeting a single VPS via SSH + Traefik
  (`private-platform-traefik`, apps under `/opt/platform/apps/<slug>`).
  `deploy.yaml` is single-environment today (host/path/branch/domain).

## Design decisions (locked in)

1. **CLI-as-API.** Every capability the frontend needs is first a CLI command
   with `--format json`. The server bridge is a thin spawn wrapper. No engine
   logic in TypeScript.
2. **JSON replaces TSV as the machine format.** TSV stays only until each
   command has JSON, then is removed. JSON payloads are the exported Go structs
   (`Report`, `ModuleInstallPlan`, `TemplateUpdatePlan`, …) serialized directly;
   their field names become the API contract — review them once for naming
   before freezing.
3. **Partial adoption is a first-class state**, recorded in the lock — not a
   quarantine storm. Existing repos adopt module-by-module with per-file
   waivers.
4. **Discovery over registry.** The project list is derived (filesystem scan +
   GitHub topic + VPS stack list), never hand-maintained.
5. **Mutations from the web UI follow the CLI's own plan→confirm→apply model:**
   the UI shows the dry-run plan and the user confirms; the server then runs
   the `--yes` form. No mutation without a plan shown first.
6. **One metadata generation.** The legacy root `project.yaml` /
   `template.lock.yaml` (lockVersion 2) and `local-projectctl-client.ts` are
   removed once the current-format equivalents exist.

---

## Phase A — `--format json` across the CLI + non-TTY safety

Prerequisite for everything below.

**Tasks:**

1. Add `--format json` to: `validate`, `module list/show/add/remove`,
   `template sync`, `template update`, `deploy status`, and the new commands in
   later phases. Implementation: serialize the existing plan/report structs
   with `encoding/json`; add a top-level envelope
   `{"ok": bool, "command": string, "data": …, "error": {"message": string, "hint": string}}`
   so failures are parseable too (today errors go to stderr as
   `VIOLATION <text>`).
2. While touching this: drop the `VIOLATION` prefix on generic errors in
   [cmd/project/main.go:21](../cmd/project/main.go) — reserve that word for
   validation findings. Errors keep the "what to do next" hint style.
3. Non-TTY behavior: when stdin is not a terminal and a command would prompt,
   fail immediately with `pass --yes or --dry-run` instead of blocking. This
   removes the special-case rules like "use --dry-run or --yes with --format
   tsv" ([main.go:324](../cmd/project/main.go)).
4. Update `local-project-cli-client.ts` to request `--format json` and parse
   the envelope; delete the text-parsing paths.

**Acceptance:** every listed command round-trips through the server bridge
with structured data; killing the TTY assumptions is covered by a test that
runs `module add` with stdin closed and asserts the fast failure.

## Phase B — Adoption flow for existing repos (`project adopt`)

Engine + CLI work; the enabler for "initialize from the website".

> **Normative spec:** [adoption-spec.md](adoption-spec.md) defines the file
> state model (match/slot/waived/missing/drift/unknown/blocker), hierarchical
> rollups, the top-down divide-and-conquer resolution algorithm with subtree
> pruning, the full CLI surface (`--take`, `--merge`, `--move`, `--waive`,
> blockers), safety rails, and acceptance tests. The tasks below are the
> summary; the spec wins on any conflict.

**Tasks:**

1. `project init` on a **non-empty** directory becomes the start of adoption:
   it writes `.project/` (lock, snapshot, values) exactly as today and does not
   touch any project file. (Already true — codify with a test.)
2. New `project adopt [directory]`:
   - `--dry-run` (default): classify every project file against the template:
     `match` (byte-equal to rendered template), `drift` (template-owned path,
     content differs), `slot` (allowed extension), `unknown` (no template
     counterpart), `missing` (template file absent). Emits per-module rollups:
     for each module, how many of its owned files are match/drift/missing.
   - `--module <name> --yes`: adopt one module — write its missing files,
     leave `drift` files untouched but record them, mark the module adopted.
   - `--waive <path> --reason <text>`: record a per-file waiver.
3. Lock additions (current format, `.project/template.lock.yaml`):

   ```yaml
   adopted: [core.fullstack]        # modules considered active for validation
   waivers:
     - path: server/web-server.ts
       reason: legacy Bun backend, migrate with backend.bun module
       added: 2026-07-02
   ```

   `project validate` scopes to adopted modules: files owned by un-adopted
   modules report as `NOT_ADOPTED` (informational), waived files report as
   `WAIVED` (informational), everything else behaves as today. `Report` gains
   `Modules []ModuleAdoption` (name, adopted, counts) so the frontend can show
   per-module adherence.
4. Migrate Project Space itself as the reference case: run init + adopt against
   `/Users/oli/projects/project-template`, adopt the ops-layer files that
   already match (deploy/**, scripts/with-secrets.sh, .env.secrets), waive the
   divergent layout (root Vite app, TS server, electron/) with reasons, then
   delete the legacy root `project.yaml`, `template.lock.yaml`, and
   `server/local-projectctl-client.ts` (+ its API types and UI usages).

**Acceptance:** `project adopt --dry-run --format json` on project-space
returns a classification with zero writes; after adopting `core.fullstack`
ops files, `project validate` is green (matches + waivers + slots, no
violations); legacy metadata and the projectctl bridge are gone.

## Phase C — Project discovery (`project list`)

**Tasks:**

1. New `project list --root <dir> --format json` (default root: configured
   projects directory, see config below). For each direct child of root (plus
   `--depth 2` option for grouped folders):
   - `kind`: `templated` (`.project/template.lock.yaml` present) |
     `legacy` (root `template.lock.yaml` with `lockVersion`) |
     `git` (a `.git` but no template metadata) | `dir` (skip by default).
   - Common fields: name, absolute path, git remote URL, current branch,
     dirty flag, last commit (sha, time, subject).
   - For `templated`: template name/version/commit, adopted modules,
     cached validation OK flag if `.project/` has one (do NOT run full
     validation per repo inside `list` — keep it fast; validation is
     on-demand per project).
2. User config `~/.config/project/config.yaml` (new, small):

   ```yaml
   projectsRoot: ~/projects
   templateRoot: ~/projects/project-template   # until remote fetch exists
   githubOwner: DotNaos
   ```

   `project setup` writes it interactively; commands that need a value and
   don't find it point at `project setup`. This also replaces the hardcoded
   template-path fallbacks being removed by the refactor plan (Phase 3 there).
3. `project create --github` additionally sets the GitHub topic
   `project-template` on the new repo (one `gh repo edit --add-topic` call), so
   GitHub-side discovery is possible later.

**Acceptance:** `project list --format json` over `~/projects` returns all git
repos with correct kinds in under ~2s for 50 repos (git info via one
`git -C <dir>` batch per repo, no network).

## Phase D — Server + frontend: projects overview, init from web, validation view

The web-facing slice. All server work extends the existing bridge pattern in
[server/local-project-cli-client.ts](../server/local-project-cli-client.ts) and
the types at [src/shared/project-space-api.ts](../src/shared/project-space-api.ts).

**Server tasks:**

1. Extend `ProjectCliCommand` with: `list`, `init`, `adopt-plan`,
   `adopt-apply` (module-scoped), `validate` (now JSON), `update-plan`.
   Mutating commands (`init`, `adopt-apply`) take the plan payload hash the UI
   received; the server re-runs the dry-run, compares hashes, and aborts with
   a "state changed, review again" error on mismatch (guards against the repo
   changing between plan and confirm).
2. Raise/parameterize the 60s timeout and 80KB output cap for `list` and
   `validate` on large repos; stream is not needed (single JSON blob).

**Frontend tasks (in [src/features](../src/features), new `projects` feature):**

3. **Projects overview page:** table/cards of everything from `project list`.
   Status chip per project: `On template vX (clean)` /
   `N violations` / `Not initialized` / `Legacy metadata` / `Template update
   available` (from cached `update-plan`). Filter by kind.
4. **Initialize from the website:** on a `git`-kind project, an "Initialize"
   action → shows what init will do (create `.project/` with template X@Y,
   nothing else) → confirm → runs `init` → lands on the adoption screen.
5. **Adoption screen:** the `adopt --dry-run` classification rendered as the
   hierarchical tree from [adoption-spec.md](adoption-spec.md): per-directory
   state rollups (worst-state-wins), expandable subtrees, pruned subtrees
   collapsed. Actions per entry follow the spec's resolution verbs: "Adopt
   module", "Take", "Merge", "Move" (classifier suggestion), "Waive" (with
   required reason) — each plan→confirm→apply. Blockers render as
   non-dismissable. This is the same JSON the CLI prints — one source.
6. **Validation view:** per-project page rendering the JSON `Report`: summary
   badge, per-module adherence bars, file tree with per-file status
   (OK/ADDED(slot)/MISSING/CHANGED/VIOLATION/WAIVED/NOT_ADOPTED), and the
   per-file diagnostics list where present. "Re-validate" button. Cache the
   last report per project with its timestamp; re-run on demand and after any
   mutation.

**Acceptance:** from the web UI, starting with a plain git repo in
`~/projects`: initialize it, adopt a module, see validation go green — no
terminal involved. Every mutation showed its plan first.

## Phase E — Environments + deployment observability

**Tasks:**

1. Extend the template's `deploy/deploy.yaml` schema to environments:

   ```yaml
   host: deploy@100.84.238.75
   environments:
     prod:
       branch: main
       path: /opt/platform/apps/{{ project.slug }}
       domain: {{ project.slug }}.os-home.net
       apiDomain: api.{{ project.slug }}.os-home.net
       default: true
     beta:
       branch: beta
       path: /opt/platform/apps/{{ project.slug }}-beta
       domain: beta.{{ project.slug }}.os-home.net
       apiDomain: api.beta.{{ project.slug }}.os-home.net
   ```

   No back-compat: flat single-env `deploy.yaml` is invalid.
   Because `deploy/` is template-owned, projects gain environments via
   `template update`.
2. `project deploy --env <name>` / `project deploy status --env <name>|--all-envs`;
   compose project name suffixed per env so stacks coexist; Traefik labels use
   the env's domains. Status JSON exposes `webUrl`, `apiUrl`, and `docsUrl`
   for UI links.
3. Deploy prompting policy fix (usability): never prompt for values coming
   from `deploy.yaml` or flags; prompt once for inferred values and offer to
   persist the answer into `deploy.yaml`. Remove the hardcoded 1Password
   secret refs in [cmd/project/deploy.go:61](../cmd/project/deploy.go) — move
   them into `deploy.yaml` (template-owned defaults).
4. Fleet status: `project deploy status --fleet --format json` — one SSH
   session to the VPS returning all stacks: `docker compose ls --format json`,
   per-app dir git SHA, container health, plus Traefik router list from its
   API. Server polls this on an interval (config: default 60s) and caches;
   frontend shows an environments matrix (project × env → status, version,
   URL, last deploy time).

**Acceptance:** project-space deploys a `beta` env alongside `prod` on the
same VPS; the frontend matrix shows both with live status; two consecutive
`deploy` runs with a fully-specified deploy.yaml ask zero questions.

## Phase F — GitHub integration

Issues/PR work lives in the **app** (server-side, using `gh` CLI via the
existing command-runner or the REST API with the 1Password-backed token);
conventions live in the **template**.

**Tasks:**

1. Template: add `.github.template/ISSUE_TEMPLATE/` (bug, task), standard
   label set (seeded by `project create --github` via `gh label`), and the
   branch-protection settings doc the legacy addon schema promised.
2. Server: `github` capability per project (repo detected from git remote):
   list issues/PRs, create issue (title, body, labels), open PR from branch.
   Reuse [server/local-github-catalog.ts](../server/local-github-catalog.ts)
   patterns/auth.
3. Frontend: issues panel on the project page; "Create issue" prefills
   template metadata (project slug label, environment if filed from the
   deploy matrix).

**Acceptance:** create a labeled issue on a discovered project from the UI;
issue templates and labels exist on newly created repos.

---

## Order & dependencies

| Phase | Depends on | Size | Notes |
|---|---|---|---|
| A JSON + non-TTY | — | S–M | prerequisite for D |
| B adopt flow | — (engine) | M–L | prerequisite for D init/adoption UI |
| C discovery + config | — | S | prerequisite for D overview |
| D web UI slice | A, B, C | L | deliverable: init + validate from web |
| E environments + fleet status | A | M | independent of B–D; template change |
| F GitHub | C (discovery) | M | independent of B, E |

The refactor plan (engine internals) can run in parallel; the only touchpoint
is Phase 3 there (removal of hardcoded template paths) which Phase C's config
file replaces — coordinate those two PRs.

## Cross-cutting

- Same PR discipline as the refactor plan: `go test ./...`, `go vet`,
  `bun run check` (TypeScript), smoke run for engine-touching phases.
- Every new command gets: docs in `docs/project-cli.md`, `--format json`,
  shell completion where applicable, and an error style that names the fix.
- Frontend adheres to existing feature-module structure under `src/features/`;
  shared types only in `src/shared/project-space-api.ts`.
- Security: the server executes the CLI with the caller's local privileges —
  web-triggered mutations must stay behind the existing local/Tailscale auth
  boundary; never expose the bridge on a public interface.
