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
--tmp
--local-tmp
--global-tmp
```

`--tmp` creates `./tmp/generated-app-<suffix>`, writes tmp template values, and installs the template's default modules.

`--local-tmp` is the explicit form of `--tmp`.

`--global-tmp` creates the generated project under `/tmp` with a random suffix.

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

## Modules

```sh
project module list [project-directory]
project module show <module> [project-directory]
project module add <module> [project-directory] --dry-run
project module add <module> [project-directory] --apply
```

## Validate

```sh
project validate [project-directory]
project validate [project-directory] --format tsv
```
