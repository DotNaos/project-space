# Project CLI

The `project` CLI creates, syncs, validates, and updates projects from templates.

## Create A Project

```sh
project new <project-directory>
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
--secrets
--tmp
--local-tmp
--global-tmp
```

`--tmp` creates `./tmp/generated-app-<suffix>`, writes tmp template values, and installs the template's default modules.

`--local-tmp` is the explicit form of `--tmp`.

`--global-tmp` creates the generated project under `/tmp` with a random suffix.

`--github` initializes Git, creates a private GitHub repository with the implicit `gh` owner, commits the project, and pushes `main`.

`--secrets` is opt-in and requires `--github`. It sets `OP_SERVICE_ACCOUNT_TOKEN` on the new GitHub repository from the project 1Password vault before the first push.

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
project init [project-directory]
```

If `[project-directory]` is omitted, the CLI uses the current directory.

## Deploy

```sh
project deploy --domain <domain> --email <acme-email>
project deploy --dry-run --domain <domain> --email <acme-email>
project deploy status
```

`project deploy` uses the existing template compose files:

- `deploy/ingress.compose.yml` for the shared Traefik ingress.
- `deploy/compose.yml` and `deploy/ingress.labels.yml` for this app.

Defaults:

- `--host` defaults to `os-vps`.
- `--path` defaults to `/opt/projects/<repo-name>`.
- `--branch` defaults to the current branch, then `main`.

`PROJECT_DOMAIN` and `TRAEFIK_ACME_EMAIL` can be set through flags or environment variables.

## Sync Template Snapshot

```sh
project template sync
project template sync --dry-run
project template sync --dry-run --format tsv
```

The project path is optional and defaults to the current directory.

`--template-path` is only needed when testing against a local template checkout instead of the template source recorded in the project lock.

## Modules

```sh
project module list [project-directory]
project module show <module> [project-directory]
project module add <module> [project-directory]
project module add <module> [project-directory] --dry-run
project module add <module> [project-directory] --yes
project module remove <module> [project-directory]
project module remove <module> [project-directory] --dry-run
project module remove <module> [project-directory] --yes
project module add <module> [project-directory] --dry-run --format tsv
project module remove <module> [project-directory] --dry-run --format tsv
```

`module add` prints the planned changes, then asks for confirmation.

Use `--dry-run` to only preview changes.

Use `-y` or `--yes` to apply without prompting.

`module install` is kept as an alias for `module add`.

## Validate

```sh
project validate [project-directory]
project validate [project-directory] --format tsv
project validate --quarantine --dry-run
project validate --quarantine --yes
```

`--quarantine` moves `not_allowed` file violations into `.project/quarantine/<original-path>`.

The quarantine directory is ignored by template validation but is not ignored by Git, so quarantined files can be reviewed and committed.
