# Project Space Codex plugin

The repository owns the canonical Project Space plugin under
`plugins/project-space`. The plugin combines two interfaces:

- the authenticated production MCP endpoint for account-wide projects,
  machines, and persistent Codex tasks;
- the local `project` CLI for worktrees, diagnostics, roadmaps, configured
  project commands, and approved deployments.

## Install from this checkout

From the repository root, add the local marketplace and install the plugin:

```sh
codex plugin marketplace add .
codex plugin add project-space@project-space
```

Start a new Codex task after installing so its skills and MCP tools are loaded.
Codex handles OAuth for `https://projects.os-home.net/mcp`; do not add a token or
an explicit OAuth resource to the plugin configuration.

## Validate changes

Run the repository contract test:

```sh
bun test tests/project-space-plugin.test.ts
```

Then install the marketplace in a clean Codex home, start a new task, and
exercise both interfaces. For the local interface, run:

```sh
project status --json
```

Use a read-only Project Space MCP operation, such as listing machines or
projects, to confirm authenticated access.
