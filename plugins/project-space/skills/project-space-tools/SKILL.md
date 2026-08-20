---
name: project-space-tools
description: Operate Project Space through its authenticated MCP server and local `project` CLI. Use for discovering Project Space projects and machines, reading or coordinating persistent Codex tasks, checking machine readiness, preparing or validating Project-managed worktrees, managing roadmaps, running configured project commands, and inspecting or performing explicitly authorized Project Space deployments.
---

# Project Space tools

Choose the interface that matches where the work happens.

- Use the Project Space MCP for signed-in, remote discovery and Codex task coordination across machines.
- Use the `project` CLI for local checkout, machine, worktree, roadmap, command, diagnostics, and deployment workflows.
- If the user names an interface, use that interface. Otherwise prefer MCP for account-wide state and the CLI for machine-local state.

When the repository is Project Space, run `project worktree context --format json`
after the agent-name claim and before consequential work. A `main` checkout is
the read-only Project Manager boundary; only an `owned` issue worktree is an
implementation surface. `foreign` and `unmanaged` contexts are non-mutating.
Invoke the versioned `project-manager` skill for the main-checkout workflow and
keep its `TASKS.md` ledger and 30-minute reconciliation contract in force. The
Manager dispatches implementation through the canonical
`project codex start --issue <n> --environment-id <id> --operation-id <id>`
operation, which owns issue-bound preparation and returns the worker task; do
not use local `project worktree prepare` as a dispatch substitute.

## Start with discovery

Before a consequential action, resolve exact targets with read-only operations.

- MCP: list projects, machines, or Codex tasks before selecting one. Read a task before sending it a message when its current state matters.
- CLI: run `project status --json`, `project list --format json`, or the relevant read-only command first.
- Use stable IDs returned by discovery instead of guessing names. Do not treat display names as unique identifiers when IDs are available.

## Use the MCP

Use the available `project_space` MCP tools for:

- listing projects and repositories;
- listing connector machines;
- listing and reading persistent Codex tasks;
- starting a Codex task on a resolved project and machine;
- sending a follow-up message to an existing task.

Treat task creation and message sending as consequential. Perform them only when the user's request authorizes that action. Return the created or updated task identity and machine when applicable.

OAuth is handled by Codex for the MCP server at `https://projects.os-home.net/mcp`. If authentication is missing, report that Project Space needs to be connected; never request or expose tokens in chat.

## Use the CLI

Confirm the CLI is available with `command -v project`. Do not install or update it unless the user asks or the current workflow explicitly requires it.

Use `project --help` and `project <command> --help` as the current command contract. Prefer machine-readable output such as `--format json` or `--json` when supported. Important command groups include:

- `project status`, `project list`, and `project doctor` for connection and readiness;
- `project codex` for persistent task start, read, send, and attach flows;
- `project worktree` for Project-managed worktree preparation and ownership checks;
- `project roadmap` for issue dependency state;
- `project run` and `project serve` for configured project workflows;
- `project deploy` and `project deploy status` for approved deployment workflows;
- `project self-update` only when an update is explicitly intended.

Run CLI commands from the relevant project or managed worktree when repository context matters. Before repository mutation, use `project worktree check`; Manager implementation dispatch must use the canonical Codex start operation rather than a local worktree preparation substitute.

The Project Manager owns completion after a worker reports ready: review the
exact PR head, unresolved feedback, CI, and realistic Preview/browser evidence;
send corrections to the same worker until clean; then ready the PR and complete
normal delivery. If no Preview-compatible surface exists, record that fact and
use the strongest realistic alternative proof.

## Safety and handoff

- Keep read-only discovery separate from changes.
- Do not start tasks, send messages, repair machines, update software, deploy, or pass confirmation flags unless the user's request authorizes the action.
- Never print access tokens, connector credentials, deployment secrets, or Infisical values.
- If MCP and CLI disagree, report both observations and their scopes; do not silently choose the more convenient result.
- Summarize what changed, identify the exact project, machine, task, worktree, or deployment involved, and state any verification that could not be completed.
