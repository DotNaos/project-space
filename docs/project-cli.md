# Project CLI

The `project` CLI is the main tool for creating, initializing, updating, and validating projects that use Project templates.

## Install

```sh
brew tap DotNaos/project-space https://github.com/DotNaos/project-space
brew install --HEAD DotNaos/project-space/project
```

## Commands

Create a new project:

```sh
project new <project-name>
```

Initialize the current directory as a project:

```sh
project init
```

Add a template module:

```sh
project module add <module-name>
```

Sync the project with the local template snapshot:

```sh
project sync
```

Update the project to the latest template version:

```sh
project update
```

Validate the current project against its template:

```sh
project validate
```

## Implementation Status

`project create`, `project module install`, and `project template sync` remain available as compatibility aliases while the CLI settles on the shorter command names above.
