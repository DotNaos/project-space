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

## Preview Template Update

```sh
project template update --dry-run
project template update --dry-run --format tsv
project template update --dry-run --template-path <template-directory>
```

This previews a template migration without writing changes. It shows value changes as `before -> after`, file changes, and files that would conflict because the project edited a template-owned file.

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
