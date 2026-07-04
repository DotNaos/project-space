# Template Engine Refactor Plan

Implementation plan for restructuring the Project CLI template engine and the
project template. Written as a handoff document: everything needed to implement
is in this file plus the referenced code.

## Repos involved

- **project-space** (this repo): the `project` CLI ([cmd/project](../cmd/project))
  and the template engine ([internal/projectvalidator](../internal/projectvalidator)).
- **project-template** (`/Users/oli/projects/project-template`, GitHub
  `DotNaos/project-template`): the real template. It is simultaneously a runnable
  fullstack app and the source for generated projects.

## How the system works today (baseline)

- A generated project vendors a full copy of the template into
  `.project/template/`, records provenance + checksum in
  `.project/template.lock.yaml`, and resolved values in
  `.project/template.values.yaml`.
- Template files contain `{{ ns.key }}` placeholders. Rendering is a hand-rolled
  scanner in [values.go](../internal/projectvalidator/values.go)
  (`renderTemplateValues`). Validation renders template files with the project's
  values and requires byte equality ([files.go](../internal/projectvalidator/files.go)).
- Frozen-region validation compiles a template body into a regex where each
  placeholder becomes a slot pattern
  ([regex.go](../internal/projectvalidator/regex.go) `compileTemplateRegex`).
- Extension points are `.slot.yaml` files (tree mode,
  [slots.go](../internal/projectvalidator/slots.go)); template-repo-only files are
  excluded via `.templateignore`
  ([templateignore.go](../internal/projectvalidator/templateignore.go)).
- Modules are declared in `template/manifest.yaml` + `template/modules/*.yaml`
  with a `values` contract and `owns` globs
  ([modules.go](../internal/projectvalidator/modules.go)).
- Legacy paths still supported: root `template.yaml` manifest, JSON lock file,
  "list mode" structure files (`structure` / `structureSlots` in the manifest).

## Design decisions (locked in — do not relitigate during implementation)

1. **Keep the placeholder language tiny and non-Turing-complete.** Do NOT switch
   to `text/template` or any general templating engine. The system depends on
   placeholders being *invertible*: the same template body must support
   `Render(values) -> bytes` and `ToRegex(slotPatterns) -> regexp`. Conditionals
   or loops would break validation.
2. **Byte-equality validation of template-owned files stays.** Template
   ownership is the product; drift is a violation.
3. **Tree mode wins.** `.template`-suffix output mapping + `.templateignore` +
   `.slot.yaml` is the one structure mechanism. List mode (structure files) is
   removed.
4. **`template/manifest.yaml` is the only manifest location.** Root
   `template.yaml` support is removed.
5. **The engine must be template-agnostic.** No template-specific policy
   (file names, frozen dependency versions, default value keys, GitHub owner,
   filesystem paths) may live in Go code.
6. **The vendored snapshot in `.project/template/` remains the source of truth
   for all project-local operations.** Remote fetching is a later, separate
   concern (Phase 8, optional).

---

## Phase 1 — Extract a formal placeholder package (`internal/placeholder`)

> **Codex comment:** Agree. This is the right first slice because it removes a
> real correctness bug and creates the shared primitive the later lint and
> validation work can reuse. I would implement this before touching broader
> template policy.

**Problem:** render ([values.go:229](../internal/projectvalidator/values.go)) and
regex-compile ([regex.go:17](../internal/projectvalidator/regex.go)) are two
independent scanners over the same syntax that must agree by coincidence.
Escaping (a preceding `$` suppresses substitution, added so GitHub Actions
`${{ ... }}` passes through) is implicit and undocumented. Missing values are
signaled by weaving a `\x00missing:<name>\x00` sentinel into the output and
scanning it back out.

**Tasks:**

1. Create `internal/placeholder` with:
   - `Parse(body []byte) (Template, error)` — splits into literal and
     placeholder segments once. Placeholder syntax: `{{ ns.key }}` with
     `[a-zA-Z0-9_.-]+` names; names must be namespaced
     (`^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$`), reusing the current
     `namespacedPlaceholderRE` rule.
   - `(Template) Render(values Values) ([]byte, error)` — returns a structured
     error type (`MissingValueError{Name string}`) instead of the sentinel
     mechanism. Delete the `\x00missing:` logic.
   - `(Template) ToRegex(slotPatterns map[string]string) (*regexp.Regexp, []string, error)`
     — replaces `compileTemplateRegex`; returns the compiled regex and the
     ordered placeholder names.
   - `(Template) Placeholders() []string` — used by the lint command (Phase 5).
2. Make escaping explicit: `$` immediately before `{{` keeps the literal text
   (current behavior — keep for GitHub Actions compatibility) AND document it in
   a package doc comment plus in `docs/project-cli.md`. Add the escape rule to
   both `Render` and `ToRegex` so the two stay in agreement (today `ToRegex`
   /`compileTemplateRegex` does NOT honor the `$` escape — this is a live bug:
   a frozen-region file containing `${{ github.ref }}` is treated as a
   placeholder by the regex path but skipped by the render path).
3. Replace all uses: `renderTemplateValues`, `compileTemplateRegex`,
   `placeholderRE` / `anyPlaceholderRE` in
   [values.go](../internal/projectvalidator/values.go),
   [regex.go](../internal/projectvalidator/regex.go),
   [files.go](../internal/projectvalidator/files.go),
   [structure.go](../internal/projectvalidator/structure.go). Delete
   `regex.go` once empty.
4. Tests: golden tests for parse/render/regex duality — for a corpus of template
   bodies, assert `regex.Match(render(values))` holds for any values matching
   the slot patterns; escape-sequence tests; missing-value error tests;
   adversarial input containing `\x00missing:` literal text.

**Acceptance:** `go test ./...` passes; no references to the sentinel remain;
`compileTemplateRegex` and `renderTemplateValues` are gone; behavior change is
limited to (a) structured errors, (b) `$` escape honored consistently in both
directions.

## Phase 2 — Move all policy from Go into template data

> **Codex comment:** Agree with the direction, but keep this narrow when
> implementing. Moving stale package/version defaults out of Go is important;
> adding a broad rules engine should stay deliberately small and only cover the
> cases the template actually needs.

**Problem A:** `diagnosePackageJSON` in
[files.go:67](../internal/projectvalidator/files.go) hardcodes frozen values
(`bun@1.2.0`, `vite dev`/`vite build`/`vitest` scripts, `@heroui/react 2.7.8`,
`react 19.0.0`) that are already out of sync with the real template
(`bun@1.3.9`, turbo scripts, no root React dependency).

**Problem B:** `defaultTemplateValuesForProject` in
[values.go:110](../internal/projectvalidator/values.go) hardcodes the seven
`project.*` keys and `github.com/DotNaos/` — duplicating what
`template/modules/core.fullstack.yaml` already declares via
`default`/`defaultFrom`. Adding a module value requires touching Go.

**Tasks:**

1. **Delete the hardcoded context map.** In `defaultTemplateValuesForProject`,
   seed only `project.slug` (slugified project directory basename, falling back
   to `example-project`). All other defaults must resolve through the module
   value specs' `default` (placeholder-rendered) and `defaultFrom` chains.
   `defaultValueForSpec` needs to resolve `defaultFrom` chains transitively and
   detect cycles (e.g. `project.name -> project.displayName -> project.name`
   exists today in core.fullstack — resolve by: if both sides are unset, the
   chain is unsatisfiable unless one has a `default`; report a clear error).
2. **Update the template** (`/Users/oli/projects/project-template/template/modules/core.fullstack.yaml`):
   ensure every value that previously came from the Go context map has a
   `default` or `defaultFrom` that fully determines it from `project.slug`:
   - `project.name`: `defaultFrom: project.displayName`
   - `project.displayName`: needs a computed default. Add ONE built-in derivation
     function to the value spec schema rather than a general expression language:
     `defaultFrom: project.slug` plus `transform: title` (kebab-case →
     "Title Case", the current `displayNameFromSlug` logic). Add `transform` to
     `schema/template-module.schema.json`. Allowed transforms: `title`, `slug`.
     Nothing else.
   - `project.goModule`: keep `default: "github.com/DotNaos/{{ project.slug }}"`
     — the owner moves from engine code into template data, which is where a
     personal default belongs.
3. **Replace `diagnosePackageJSON` with a declarative structured-file spec.**
   Add an optional per-file rule file to the template, discovered like slots:
   `<path>.rules.yaml` next to the template source (e.g.
   `package.template.json.rules.yaml`), or a `rules:` section in the module
   file mapping paths to rule lists — pick the module-file variant (keeps
   authoring in one place, is covered by the schema). Rule shape:

   ```yaml
   rules:
     package.json:
       format: json
       entries:
         - path: /name
           kind: slot
           pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$"
         - path: /packageManager
           kind: frozen        # frozen = must equal the rendered template value
         - path: /scripts/*
           kind: open          # anything allowed
         - path: /dependencies/*
           kind: deny          # nothing beyond template-declared entries
   ```

   Engine side: a small `internal/structrules` package that loads rules,
   validates a JSON document, and produces the existing `FileDiagnostic`
   entries. `frozen` compares against the *rendered template* value, so version
   bumps in the template propagate without engine changes. Files with a rule
   entry are validated structurally; files without one keep whole-file byte
   equality.
4. Delete `diagnosePackageJSON`, `checkFrozen`, `checkSlotString`,
   `objectValue` from files.go.

**Acceptance:** grep the engine for `DotNaos`, `heroui`, `vite`, `bun@`,
`project.displayName` — zero hits outside tests/testdata. A new module value
added purely in YAML gets a working default in `--tmp` generation.

## Phase 3 — Remove legacy code paths

> **Codex comment:** Agree, but do this after Phase 1 and the minimum Phase 2
> cleanup are green. Removing fallback paths changes CLI behavior, so each
> removed path needs a clear error message and a replacement path in the docs.

**Tasks:**

1. Remove root `template.yaml` fallback: `findTemplateManifest`
   ([template.go:71](../internal/projectvalidator/template.go)) accepts only
   `template/manifest.yaml`. Update error message.
2. Remove JSON lock fallback in `readTemplateLock`
   ([template.go:13](../internal/projectvalidator/template.go)).
3. Remove list mode: `StructurePath`/`StructureSlotsPath` from `TemplateSpec`,
   the non-tree branch of `validateStructure`, `readStructureLines`,
   `compilePathPattern`'s structure-slots JSON consumer (`readJSONFile` if then
   unused), the `slotRule`/`regexpWrapper` types in
   [structure.go](../internal/projectvalidator/structure.go). `TreeMode` becomes
   unconditional — delete the flag.
4. Remove inline (MappingNode) module definitions in `decodeTemplateModule`
   ([template.go:135](../internal/projectvalidator/template.go)) — modules are
   always files under `template/modules/`. (The in-repo legacy fixture is the
   only user.)
5. Move [templates/project-template](../templates/project-template) (legacy
   format, stale module set `core.repo`/`feature.modules`) into
   `internal/projectvalidator/testdata/`, converted to the current format, and
   update tests. Remove the `templates/project-template` default fallback in
   `resolveInitTemplatePath` ([init.go:190](../internal/projectvalidator/init.go));
   the default resolution order becomes: `--template-path` flag →
   `PROJECT_SPACE_TEMPLATE_ROOT` env → error with a clear message. Also delete
   the hardcoded `/Users/oli/projects/project-template` and
   `../project-template` candidates in `resolveTemplateSourceRoot`
   ([sync.go:102](../internal/projectvalidator/sync.go)) — a machine-specific
   absolute path must not ship in the binary. Document
   `PROJECT_SPACE_TEMPLATE_ROOT` in `docs/project-cli.md`.

**Acceptance:** `go test ./...` passes; `rg 'template\.yaml|template\.lock\.json|StructurePath|TreeMode|/Users/oli'` in engine code returns nothing.

## Phase 4 — Snapshot and checksum only the render-relevant set

> **Codex comment:** Agree. This should use one shared file-selection function
> for copy and checksum; otherwise the two will drift again. The migration path
> matters because existing generated projects already have old checksums.

**Problem:** `copyDirectory` and `checksumTemplateRoot`
([sync.go](../internal/projectvalidator/sync.go),
[checksum.go](../internal/projectvalidator/checksum.go)) skip only
`shouldSkipTemplateWorkDir` names — they do NOT apply `.templateignore`. Every
generated project vendors the template's `bun.lock` (~235 KB), `docs/`,
`Requirements.md`, `.github/`; the checksum churns whenever a template-repo-only
doc changes, producing spurious update prompts.

**Tasks:**

1. Define the snapshot set: files NOT matched by `.templateignore`, PLUS
   `template/**` (manifest, modules, schemas), PLUS all `.slot.yaml` files,
   PLUS `.templateignore` itself. (`template/**` and `.slot.yaml` are listed in
   `.templateignore` because they must not become project files, but they must
   be in the snapshot because the engine reads them from `.project/template/`.)
   Implement as one function `snapshotFiles(templateRoot) ([]string, error)`
   used by both copy and checksum so they can never diverge.
2. Apply it in `copyDirectory` (via a filter parameter or a new
   `copySnapshot`) and `checksumTemplateRoot`.
3. Migration: existing projects have checksums over the old set. On
   `project template sync`, recompute and rewrite the lock checksum (sync
   already does this). Add a note to the sync output when the checksum
   algorithm version changes; store `checksumVersion: 2` in the lock and treat
   a missing version as 1 (skip mismatch error, prompt to re-sync instead).

**Acceptance:** a generated tmp project's `.project/template/` contains no
`bun.lock`, `docs/`, `Requirements.md`, or `.github/` (template-repo `.github`,
not `.github.template`); editing the template repo README does not change the
checksum; sync/validate/update round-trip green on a fresh smoke run.

## Phase 5 — `project template lint`

> **Codex comment:** Agree, after the placeholder package exists. The lint
> command should mostly compose existing engine checks instead of becoming a
> second engine with separate rules.

New command validating a template checkout *without* generating a project.
Runs against `--template-path` (default: cwd if it contains
`template/manifest.yaml`).

**Checks:**

1. Manifest and every module file parse and satisfy the JSON schemas in
   `schema/`.
2. **Ownership coverage:** every rendered template file is matched by ≥1
   module's `owns` globs (unowned files can never be installed by
   `module add` — today this fails silently).
3. **Ownership overlap:** warn when two modules own the same path
   (`moduleForPath` currently attributes to the alphabetically-first match,
   which is arbitrary).
4. **Placeholder/value coherence:** every `{{ ns.key }}` in every non-ignored
   template file is declared in some module's `values`; every declared value is
   used somewhere (warning, not error).
5. **Default resolvability:** with only `project.slug` seeded, all required
   values of the default-module closure resolve (catches `defaultFrom` cycles).
6. Every `.slot.yaml` compiles (name present, allow patterns valid, referenced
   `patterns` regexes compile).
7. `.templateignore` patterns compile (today `readTemplateIgnore` silently
   drops invalid lines — lint should surface them).
8. Output collision check: two sources rendering to the same output path
   (already an error in `loadTemplateTree` — surface as lint finding).

Wire into `template_smoke.go` so smoke runs lint first. Add to CI of the
template repo (`.github/workflows/ci.yml` there) once available via a released
binary — for now document `go run ./cmd/project template lint` usage.

**Acceptance:** lint on `/Users/oli/projects/project-template` passes (fix any
real findings it surfaces there — expected: unowned files, undeclared
placeholders in `.env.local.example` / `Requirements.md`-adjacent files if not
ignored); lint on a fixture with each violation class fails with a specific
message.

## Phase 6 — Reverse-rendering: make the template repo fully runnable

> **Codex comment:** This is useful, but it is the riskiest phase in the plan.
> Reverse-rendering can create surprising replacements, so I would only take it
> on after lint exists and can enforce ambiguity checks. This should be treated
> as deferrable, not part of the first cleanup pass.

**Problem:** the template repo mixes two conventions. `AGENTS.template.md`
exists so the repo can have its own `AGENTS.md`, but `package.json` and
`server/go.mod` contain raw `{{ project.slug }}` placeholders, so the template
repo itself cannot cleanly `bun install` / `go build` — defeating
"the template is a working app."

**Design:** the template repo keeps REAL values in runnable files and declares
its own identity in `template/values.yaml` (e.g. `project.slug:
project-template`, `project.goModule: github.com/DotNaos/project-template`).
At snapshot time (init/sync), the engine *unrenders*: for each template source
file, longest-match replaces known value strings with their placeholders,
producing the parametrized snapshot. `.template`-suffix files may still contain
literal placeholders (they are not runnable anyway); unrendering skips files
that already contain placeholders.

**Tasks:**

1. Add `template/values.yaml` support: `Parse` in the spec loader; schema.
2. `internal/placeholder`: add `Unrender(body []byte, values map[string]string) []byte`
   — replace value occurrences with `{{ key }}`, longest value first;
   deterministic tie-break by key name. Values shorter than 3 characters are
   never unrendered (guard against `a` matching everywhere); lint (Phase 5)
   errors if a template self-value is that short or if one value is a substring
   of another in a way that makes unrendering ambiguous.
3. Snapshot pipeline: unrender during `copySnapshot` for non-`.template` files.
   Round-trip check as part of smoke: `render(unrender(file), templateValues)
   == file` for every snapshot file.
4. Migrate the template repo: replace inline placeholders in `package.json`,
   `server/go.mod`, `clients/**`, `deploy/**`, `.env.secrets` comment examples
   etc. with real `project-template` values; delete now-redundant `.template`
   twins where the only difference was placeholders (keep ones that differ in
   content, like `AGENTS.template.md`); verify `bun install && bun run check`
   and `cd server && go build ./...` pass in the template repo itself.

**Acceptance:** template repo builds and runs as-is; `project new --tmp`
against it produces the same generated output as before (byte-compare a
generated project before/after this phase, modulo intentional fixes); smoke
round-trip check green.

*Note: this phase is the largest behavioral change. It is deliberately after
Phase 5 so lint can police the ambiguity constraints, and independent of
Phases 7–8 — it can be deferred if time-boxed.*

## Phase 7 — 3-way merge for template updates

> **Codex comment:** Agree, but this should be isolated from the placeholder and
> snapshot cleanup. It changes user-facing update behavior, so fixture coverage
> for clean merge and conflict marker paths is non-negotiable.

**Problem:** `PlanTemplateUpdate` ([update.go](../internal/projectvalidator/update.go))
classifies conflicts (project file ≠ old rendered output) but resolution is
"copy into `.conflicts/<label>/`".

**Tasks:**

1. On `project template update` (non-dry-run apply — implement apply if still
   missing; today only `--dry-run` is documented), for each UPDATE-conflict
   file run a 3-way merge: base = old template rendered with old values,
   theirs = new template rendered with new values, mine = project file. Use a
   Go diff3 implementation or shell out to `git merge-file` (git is already a
   hard dependency of the workflow); on clean merge, write the result; on
   conflict, write the file with conflict markers AND keep the `.conflicts/`
   copy of all three sides.
2. Plan output gains a `Result` value `merged` alongside `clean`/`conflict`.
3. After apply: rewrite lock (version/commit/checksum), re-run
   `ensureTemplateValues`, and print a validate summary.

**Acceptance:** fixture test: project with a local edit to a template-owned
file + template update touching a different region of the same file → merges
cleanly; same-region edit → conflict markers + `.conflicts/` copies.

## Phase 8 (optional, last) — real template distribution

> **Codex comment:** Keep this optional and late. Until remote fetching exists,
> the UI and CLI should not imply that template provenance is independently
> verified from GitHub.

Only if wanted after 1–7. Implement `fetchTemplate(ref string, version string)`
→ clone `github.com/<owner>/<repo>` at tag/commit into
`~/.cache/project-space/templates/<owner>/<repo>/<commit>/`, then snapshot from
there. `template.lock.yaml` `version`/`commit` become verifiable provenance.
Until then they stay self-reported; do not build UI that pretends otherwise.

## Phase 9 — package restructure (mechanical, do last)

> **Codex comment:** Agree with the target shape, but only after behavior has
> stabilized. Package splitting before the functional changes would create churn
> and make the real engine changes harder to review.

Split `internal/projectvalidator` (name says read-only; it is the whole engine):

- `internal/templatespec` — manifest/module/values-spec parsing, slots,
  templateignore, structrules (Phase 2), lint checks (Phase 5).
- `internal/placeholder` — already exists after Phase 1 (+ Unrender from 6).
- `internal/snapshot` — sync, copy, checksum, lock read/write.
- `internal/validate` — ValidateProject, structure, files, quarantine, report.
- `internal/modules` — install/remove/list/closure.
- `internal/update` — update planning + 3-way apply.
- `cmd/project` — unchanged surface; also split the 1273-line
  [main.go](../cmd/project/main.go) into one file per command
  (`create.go`, `init.go`, `module.go`, `template.go`, `validate.go`).

Pure moves + renames; no behavior change; do it in a single commit so
`git log --follow` stays useful. Fix the pre-existing perf issue while moving:
`moduleForPath` ([modules.go:346](../internal/projectvalidator/modules.go))
recompiles every `owns` regex per call and is invoked per file — compile once
at template load into the spec.

---

## Cross-cutting requirements

- Every phase lands as its own PR with `go test ./...`,
  `go vet ./...`, and a smoke run:
  `go run ./cmd/project template smoke --template-path /Users/oli/projects/project-template --version local --commit local --skip-secrets-doctor`
  (Phases 1–5 must not change generated output; assert by generating a tmp
  project before starting and byte-comparing after each phase, excluding
  `.project/`).
- Update `docs/project-cli.md` and the template repo's `docs/` (notably
  `template-manifest.md`, `template-output-sources.md`) in the same PR as the
  behavior they describe. The open question in `template-output-sources.md`
  ("manifest-listed vs discovered sources") is answered: discovered (tree
  mode), listed nowhere.
- Update `schema/template-manifest.schema.json` and
  `schema/template-module.schema.json` in the template repo for: `transform`
  (Phase 2), `rules` (Phase 2), `template/values.yaml` (Phase 6).
- No new third-party dependencies except (optionally) a diff3 library in
  Phase 7.
- Error messages must name the file and the fix (existing style: "missing X;
  run project template sync to restore it").

## Suggested order & sizing

> **Codex comment:** My implementation order is: Phase 1 first, then the narrow
> policy cleanup from Phase 2, then legacy removal, snapshot cleanup, lint, and
> only then decide whether reverse-rendering is worth the risk.

| Phase | Depends on | Size |
|---|---|---|
| 1 placeholder package | — | M |
| 2 policy → template data | 1 | M |
| 3 legacy removal | — (parallel with 1–2) | S |
| 4 snapshot set | 3 | S |
| 5 template lint | 1–4 | M |
| 6 reverse-rendering | 5 | L (deferrable) |
| 7 3-way update | 1, 4 | M |
| 8 distribution | 4 | M (optional) |
| 9 package split | all merged | S (mechanical) |
