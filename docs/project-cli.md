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
--temp
--local-temp
--global-temp
```

`--temp` creates `./temp/generated-app`, writes temp template values, and installs the template's default modules.

`--local-temp` is the explicit form of `--temp`.

`--global-temp` creates the generated project under `/tmp`.

Example:

```sh
project new \
  --template DotNaos/project-template \
  --template-path . \
  --version local \
  --commit local \
  --temp
```

Named local temp project:

```sh
project new my-app --temp
```

Named global temp project:

```sh
project new my-app --global-temp
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
