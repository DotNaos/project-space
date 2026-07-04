---
title: Project CLI Reference
description: Commands and workflows for the Project CLI.
---

The `project` CLI is the local command-line interface for Project. It calls the same Project functionality that is also exposed through API surfaces.

## Create A Project

```sh
project new <directory>
```

`new` is an alias for `create`.

Useful flags:

```sh
--template <owner/repo>
--template-path <path>
--version <version>
--commit <commit-or-label>
--force
--github
--github-visibility <private|public>
--tmp
--local-tmp
--global-tmp
```

`--tmp` creates `./tmp/generated-app-<suffix>`, writes tmp template values, and installs the template's default modules.

`--local-tmp` is the explicit form of `--tmp`.

`--global-tmp` creates the generated project under `/tmp` with a random suffix.

`--github` initializes Git, creates a private GitHub repository by default with the implicit `gh` owner, commits the project, and pushes `main`.

GitHub repositories are private by default. Use `--github-visibility public` to create a public repository.

`--github` also sets `OP_SERVICE_ACCOUNT_TOKEN` on the new GitHub repository from the project 1Password vault before the first push.

When `--template-path` and `PROJECT_SPACE_TEMPLATE_ROOT` are omitted, `project new`
fetches the GitHub template named by `--template`. If `--template` is omitted,
it uses `DotNaos/project-template`.

Example:

```sh
project new \
  --template DotNaos/project-template \
  --template-path . \
  --version local \
  --commit local \
  --tmp
```

Named local tmp project:

```sh
project new my-app --tmp
```

Named global tmp project:

```sh
project new my-app --global-tmp
```

## Initialize An Existing Project

```sh
project init [directory]
```

If `[directory]` is omitted, the CLI uses the current directory.

## Plan Existing Project Adoption

```sh
project adopt [directory]
project adopt [directory] --format json
project adopt [directory] --waive <path-pattern> --reason <text>
project adopt [directory] --waive <path-pattern> --reason <text> --yes
```

Without an action flag, this is read-only. It classifies files as matching the
template, missing from the project, changed from the template, allowed by a
slot, or unknown to the template. Template-defined blockers, such as plaintext
secret files, are always reported before ignored paths or slots are pruned.
Files ignored by the template are otherwise left out of the adoption noise.

`--waive` records tracked adoption debt in `.project/template.lock.yaml`.
Waivers require a reason and cannot cover blocker files.

## Create The Project Token

```sh
project token create
project token create --expires-in 24h
project token create --dry-run
project token create --yes
project token create --json
```

This creates the one Project service-account token used to read shared secrets from 1Password.

Fixed policy:

- Vault: `projects`
- Permission: `read_items`
- Stable item: `project-ci-service-account`
- Stable reference: `op://projects/project-ci-service-account/password`

`--expires-in` creates a temporary token item instead of replacing the stable CI token.

1Password item names created by this command use slug-style names, so generated secret references do not contain spaces.

The token value is stored directly in 1Password and is never printed.

## Deploy

```sh
project deploy --domain <domain> --api-domain <api-domain>
project deploy --dry-run --domain <domain> --api-domain <api-domain>
project deploy status
```

`project deploy` uses the existing template compose files:

- `deploy/compose.yml` and `deploy/ingress.labels.yml` for this app.
- The VPS-owned `private-platform-traefik` ingress and `traefik-public` Docker network.

Configuration can live in `deploy/deploy.yaml`:

```yaml
host: deploy@100.84.238.75
path: /opt/platform/apps/my-project
branch: main
domain: my-project.os-home.net
apiDomain: my-project-api.os-home.net
```

Flags override config.

If a value comes from `deploy/deploy.yaml`, an environment variable, Git config, or an inferred convention, the CLI asks before using it.

Supported environment fallbacks are `PROJECT_DEPLOY_HOST`, `PROJECT_DEPLOY_PATH`, `PROJECT_DOMAIN`, `PROJECT_API_DOMAIN`, and their older aliases.

## Sync Template Snapshot

Project template commands expect local template state in the project:

```text
.project/template.lock.yaml
.project/template/
.project/template.values.yaml
```

`project init` and `project create` create this state. Normal template commands use it automatically, so no template path is needed.

```sh
project template sync
project template sync --dry-run
project template sync --dry-run --format tsv
```

The project path is optional and defaults to the current directory.

`--template-path` is only needed when testing against a local template checkout instead of the template source recorded in the project lock.

For `project init`, `project new`, and template sync/update commands, local
sources are resolved in this order: `--template-path`, then
`PROJECT_SPACE_TEMPLATE_ROOT`, then the GitHub repository recorded in
`.project/template.lock.yaml`.

Fetched templates are cached under the user cache directory at
`project-space/templates/<owner>/<repo>/<commit>/`. Set
`PROJECT_SPACE_TEMPLATE_CACHE` to use a different cache directory.

## Template Placeholders

Template files use `{{ ns.key }}` placeholders, such as `{{ project.slug }}`.

A `$` immediately before `{{` escapes the placeholder and keeps it as literal text. Use this for GitHub Actions expressions such as `${{ github.ref }}`.

## Lint A Template

```sh
project template lint --template-path <template-directory>
project template lint --template-path <template-directory> --format json
```

This validates a template checkout without generating a project. It checks the
manifest, module files, ownership coverage, placeholder declarations, default
values, slot files, `.templateignore`, and reverse-rendering self values.

## Update From Template

```sh
project template update --dry-run
project template update --dry-run --format tsv
project template update --yes
project template update --template-path <template-directory>
```

This updates a project from its template. It prints the plan first. Use
`--dry-run` to preview without writing, or `--yes` to apply without prompting.

For changed template-owned files, the update uses a three-way merge:

- clean files are replaced with the new rendered template version.
- independent local edits are merged and shown as `merged`.
- overlapping edits are written with conflict markers, and the original local
  file plus both template sides are copied to `.conflicts/<update>/`.

`--template-path` is only for testing an update against a specific local template checkout. Normal use reads the source from `.project/template.lock.yaml`.

## Smoke Test A Template

```sh
project template smoke --template-path <template-directory> --version local --commit local
project template smoke --template-path <template-directory> --version local --commit local --skip-checks --container
```

This creates a generated tmp project, installs default modules, validates it, and runs the generated project's normal checks.

Use `--container --skip-checks` for a focused generated-container smoke test.

Use `--skip-secrets-doctor` for local smoke checks when no 1Password service token is available.

## Modules

```sh
project module list [directory]
project module show <module> [directory]
project module add <module> [directory]
project module add <module> [directory] --dry-run
project module add <module> [directory] --yes
project module remove <module> [directory]
project module remove <module> [directory] --dry-run
project module remove <module> [directory] --yes
project module add <module> [directory] --dry-run --format tsv
project module remove <module> [directory] --dry-run --format tsv
```

`module add` prints the planned changes, then asks for confirmation.

Use `--dry-run` to only preview changes.

Use `-y` or `--yes` to apply without prompting.

`module install` is kept as an alias for `module add`.

## Validate

```sh
project validate [directory]
project validate [directory] --format tsv
project validate --quarantine --dry-run
project validate --quarantine --yes
```

`--quarantine` moves `not_allowed` file violations into `.project/quarantine/<original-path>`.

The quarantine directory is ignored by template validation but is not ignored by Git, so quarantined files can be reviewed and committed.

Paths waived through `project adopt --waive` are reported as `WAIVED` and do not
fail validation. Template-defined blockers still fail validation even if a lock
file was edited manually to waive them.
