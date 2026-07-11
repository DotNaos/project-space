---
title: Codex Worktree Ownership
description: The isolated branch and worktree workflow used by Codex chats.
---

# Codex Worktree Ownership

Repository changes never run in the shared `main` worktree. Each Codex chat
uses a dedicated branch and a Project-managed worktree under:

```text
~/projects/.worktrees/{project}/{branch}
```

GitHub issues are recommended for larger tasks, but they are optional. A branch
and an isolated worktree are required for every repository mutation.

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
