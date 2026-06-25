# Project Template Engine Plan

This plan defines how `project-space`, the `project` package, and `project-template` should converge.

## Goals

### 1. One Shared Project Package

Build a reusable `project` package inside `project-space`.

The package owns the template engine, validation, reports, sync, and init behavior. The CLI, REST API, and connector must all call this same package instead of implementing their own validation logic.

Converged when:

- `project validate` and the REST/connector validation return the same result for the same project.
- The CLI is only an entrypoint, not the owner of the engine.
- The engine can be tested without starting the desktop app.

### 2. Templates Are File-Tree Contracts

Define templates as real file trees with placeholders and local slot files.

Template-owned files are normal files in the template tree. Dynamic values use `{{ namespace.value }}` placeholders. Project-owned files are allowed only where a nearby `.slot.yaml` file explicitly defines them.

Validation follows three rules:

1. If the file exists in the template tree, it is OK.
2. If the file matches an allow pattern from a template `.slot.yaml`, it is a slot file.
3. If the file matches neither the template tree nor a slot pattern, it is a violation.

If the template has no `.slot.yaml` files, there are no slots. In that case the project must be an expanded version of the template tree, with placeholders filled from project values and no extra files.

Templates also need a `.templateignore` file in the template root. It works like a project-file mapping ignore file:

- Files matched by `.templateignore` remain part of the local template snapshot.
- Files matched by `.templateignore` remain part of the template checksum.
- Files matched by `.templateignore` are not expected to exist in the project.
- Files matched by `.templateignore` may still be read by the validator as metadata or documentation.

This allows the template to contain files such as `.slot.yaml`, template README files, fixtures, and internal template documentation without requiring those files to exist in every generated project.

Converged when:

- A file present in the template tree is treated as template-owned.
- A file matching a `.slot.yaml` rule is treated as allowed project-owned content.
- A file matching neither is reported as a violation.
- Files matched by `.templateignore` are not mapped to project files.
- `structure.j2` and global structure slot files are no longer needed.

### 3. Projects Carry Template Context Locally

Each project should commit only the template lock and template values, while keeping the resolved template snapshot as a gitignored local cache.

Target project layout:

```text
.project/
  template.lock.yaml
  template.values.yaml
  template/
```

Converged when:

- `template.lock.yaml` identifies the exact template source and version.
- `template.lock.yaml` stores a checksum for the resolved template snapshot.
- `template.values.yaml` contains only placeholder values, never file allowlists.
- `.project/template/` can be regenerated with `project template sync`.
- Agents and tools can inspect the template locally without fetching remote context.
- Validation fails if `.project/template/` has been edited locally and no longer matches the lock checksum.

## Checklist

### Package Boundary

- [ ] Move validation logic into a shared `project` package.
- [ ] Keep `cmd/project` as a thin CLI wrapper.
- [ ] Add an API/connector adapter that calls the same package.
- [ ] Keep Homebrew building the CLI entrypoint from the package.

### Template Format

- [x] Replace `structure.j2` with template tree scanning.
- [x] Treat normal template files as template-owned files.
- [x] Add `.templateignore` at the template root.
- [x] Use `.templateignore` to exclude template-only files from project-file mapping.
- [x] Keep `.templateignore` matches inside the template checksum.
- [x] Read `.slot.yaml` files as template metadata while excluding them from project-file mapping.
- [x] Render `{{ namespace.value }}` placeholders before comparing template-owned files.
- [x] Report missing placeholder values clearly.

### Slot Format

- [x] Define `.slot.yaml` next to the directory it governs.
- [x] Scope each `.slot.yaml` to its own subtree only.
- [x] Treat slot patterns as relative to the directory that contains the `.slot.yaml` file.
- [x] Support path patterns for allowed project-owned files.
- [x] Support named captures such as `{feature}`.
- [x] Support wildcard path patterns such as `*` and `**/*`.
- [x] Reject absolute slot paths.
- [x] Reject slot patterns containing `..`.
- [x] Keep file allow rules only in slots, never in project values.
- [x] Do not allow project files to override or edit slot rules.

### Project Metadata

- [x] Add committed `.project/template.lock.yaml`.
- [x] Add committed `.project/template.values.yaml`.
- [x] Add gitignored `.project/template/`.
- [x] Add `project template sync`.
- [x] Store and verify the checksum of `.project/template/`.
- [x] Make `project validate` use the local template snapshot by default.
- [x] Fail validation before applying slot rules if the local template snapshot checksum changed.

### Project Space Adoption

- [x] Convert the current template into the new file-tree format.
- [x] Add slots for real `project-space` extension areas.
- [x] Decide whether generated output such as `dist/` is ignored or explicitly modeled.
- [x] Make `project-space` validate successfully against `project-template`.

### Verification

- [x] Run `go test ./...`.
- [x] Run `project validate` in `project-space`.
- [ ] Verify CLI and REST/connector reports match.
- [ ] Reinstall through Homebrew and verify `project validate` still works.
- [x] Verify shell completion still works.
