---
title: Codex Worktree Ownership
description: The isolated branch and worktree workflow used by Codex chats.
---

# Codex Worktree Ownership

Repository changes never run in the shared `main` worktree. Worktrees created
through the Project CLI use a dedicated branch and the Project-managed layout:

```text
~/projects/.worktrees/{project}/{branch}
```

GitHub issues are recommended for larger tasks, but they are optional. A branch
and an isolated worktree are required for every repository mutation.

In the compute hierarchy, this checkout is a **Runner Workspace**. It belongs
to one agent run and executes inside one **Environment** such as native macOS,
WSL, a devcontainer, a GitHub Codespace, or a cloud sandbox. A worktree path is
not a Host or Environment identity, and recreating a workspace must not create
a duplicate Connector installation. See
[Compute Platforms, Hosts, and Environments](./compute-environments.md).

Codex Desktop creates and owns its own machine-local worktrees separately. The
recommended root is:

```text
~/projects/.codex-worktrees
```

Project Space does not read, write, or require Codex configuration. Changing the
Codex Desktop root affects newly created Codex worktrees only; existing
worktrees are not moved.

## Discovery And Identity

Project Space discovers worktrees from `git worktree list --porcelain`, using
the selected repository's Git metadata as the source of truth. Every registered
worktree is included regardless of whether its path looks Project-managed,
Codex-created, or external. Directory scans never create actionable worktree
records.

Paths classify rows for display only. They are not browser-facing identities.
Each machine derives an opaque worktree ID from Git's own linked-worktree
registration and resolves that ID again locally before an action can use the
path. This keeps detached worktrees distinct even when they share a commit or
final directory name.

Registered state is reported honestly:

- a branch is present only when Git reports a real local branch;
- detached worktrees show their exact HEAD commit and a neutral label;
- locked and prunable annotations are preserved with their reasons;
- missing, broken, and unavailable registrations remain visible but are not
  actionable;
- only worktrees with `ready` status can be used for actions.

## Start Without An Issue

From any checkout of the project, run:

```sh
project worktree prepare codex-worktree-ownership
```

The command fetches the latest `origin/main`, creates a `task-...` branch in the
standard worktree directory, and records the current `CODEX_THREAD_ID` in the
worktree-specific Git configuration. The ownership metadata is not tracked and
does not make the worktree dirty.

Ownership checks and updates are serialized with a repository-wide lock stored
in the shared Git metadata. The operating system releases that lock if a CLI
process exits or crashes, while the durable owner remains the worktree-specific
Git configuration.

If a branch and its standard-path worktree already exist but have no owner,
claim the current checkout without inventing another task name:

```sh
project worktree prepare
```

The no-argument form only claims a clean checkout whose `HEAD` still matches
the current `origin/main`. It never claims `main`, a worktree outside the
standard directory, a branch with existing commits, or a worktree owned by
another persistent Codex task.

## Start From An Existing Issue

For larger tasks:

```sh
project worktree prepare --issue 123
```

The issue must exist and be open. Its number and title determine a branch such
as `issue-123-add-codex-owned-worktrees`.

Both commands support machine-readable output:

```sh
project worktree prepare --issue 123 --format json
```

## Validate Before Editing

Run this before changing files:

```sh
project worktree check
```

The check fails closed when:

- `CODEX_THREAD_ID` is missing or malformed;
- the current checkout is the shared default-branch worktree;
- the worktree is outside `.worktrees/{project}/{branch}`;
- the worktree was not prepared by the Project CLI;
- the same Codex thread is recorded as owner of multiple worktrees;
- or another Codex thread owns it.

The same Codex chat may keep using its worktree for multiple related changes.
Calling `prepare` again from the same repository returns that existing worktree.
A different chat receives a different branch and path even when it uses the
same task name.

Only the persistent main Codex task runs `prepare` and `check`. Delegated
subagents have distinct thread IDs, so they work under the main task's existing
claim instead of replacing or validating it with their subagent IDs.

## Collision Rules

The CLI never adopts, stashes, resets, removes, or commits another task's work.
If a branch or path is already occupied, it derives a distinct branch for the
current thread. Concurrent preparations for the same thread converge on one
owned worktree and remove an unused worktree created by the losing operation.
Agents must still inspect active Codex tasks before editing, because separate
worktrees prevent local overwrites but cannot prevent two pull requests from
changing the same logical code.
