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
- or another Codex thread owns it.

The same Codex chat may keep using its worktree for multiple related changes.
Calling `prepare` again from the same repository returns that existing worktree.
A different chat receives a different branch and path even when it uses the
same task name.

## Collision Rules

The CLI never adopts, stashes, resets, removes, or commits another task's work.
If a branch or path is already occupied, it derives a distinct branch for the
current thread. Agents must still inspect active Codex tasks before editing,
because separate worktrees prevent local overwrites but cannot prevent two
pull requests from changing the same logical code.
