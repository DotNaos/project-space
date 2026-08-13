---
title: Project Connect Protocol
description: Machine Credential enrollment without a permanent Connector.
---

# Project Connect Protocol

`project connect` remains the supported way to register a machine and obtain
its owner-bound Machine Credential. What is retired is the permanent Connector
process that older releases started after enrollment.

```text
project connect
  -> browser approval
  -> owner-bound Machine Credential
  -> authenticated Environment discovery and control requests
  -> generation-bound Workspace Runtime when work is launched
```

The Machine Credential authenticates the Project CLI and typed control APIs. It
is not a continuously running agent, does not open a command socket, and does
not establish execution identity by itself. Execution still requires an exact
Environment Instance and a pinned Workspace Runtime bound to its Workspace,
commit, manifest, generation, and owner.

Use this flow after enrollment:

```text
project environment bootstrap
  -> detect the managed Workspace and one exact Environment Instance
  -> ask for project environment bootstrap <environment> only when ambiguous
  -> generation-bound Workspace Runtime session
```

Connector IDs, historical machine IDs, hostnames, and old registration tokens
cannot substitute for canonical Environment, Workspace, or Runtime bindings.
See [Workspace runtimes](./workspace-runtimes.md) and [Workspace Runtime
sessions](./workspace-runtime-sessions.md).

## Existing Connector artifacts

Older installations may retain a Connector executable, service, scheduled
task, LaunchAgent, registration token, or Connector configuration. These are
cleanup-only artifacts. Platform installers and uninstallers may remove exact
known artifacts, but must not invoke the retired Connector or perform broad
recursive deletion. The current Machine Credential remains separate and may
be revoked explicitly with `project disconnect`.

The signed machine-tools release manifest remains
`project-space.connector-runtime-release/v1`. The schema, canonical payload,
signature verification, trust roots, and installed v0.21.17 parser stay
unchanged for upgrade compatibility.
