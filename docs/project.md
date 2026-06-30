---
title: Project Model
description: CLI, API, and internal logic for template-backed project operations.
---

Project is the package that owns template-backed project operations.

It is not only a CLI. The CLI is one interface over the same functionality that can also be exposed through an API and used internally by the Project Space connector.

## Parts

- CLI: local command-line interface, exposed as `project`.
- API: programmatic surface for Project Space and connector workflows.
- Internal logic: template resolution, module operations, validation, migration planning, deployment planning, and shared project rules.

## Current Docs

- [CLI reference](/docs/project-cli)

## Documentation Rule

Docs should describe Project functionality first, then explain which interface exposes it.

For example, template validation is a Project capability. The CLI exposes it as:

```sh
project validate
```

The same capability should also be usable through the API/internal package surface where Project Space needs it.
