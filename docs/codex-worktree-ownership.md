# Codex worktree ownership

Repository changes always happen on a dedicated branch in a linked worktree. A GitHub issue is the default scope for larger work, but a small, clearly described task may use a task-named branch without creating an issue first.

The persistent main Codex task claims its worktree before implementation:

```bash
project worktree prepare
```

The command reads `CODEX_THREAD_ID`; callers do not pass a thread ID manually.

## States

```text
No CODEX_THREAD_ID
  -> blocked: use a persistent Codex task

Shared main worktree
  -> blocked: create a linked branch worktree

Linked worktree without an owner
  -> claim it for CODEX_THREAD_ID

Linked worktree owned by CODEX_THREAD_ID
  -> ownership confirmed

Linked worktree owned by another thread
  -> blocked: create and claim another worktree
```

The owner and claim time are stored in a worktree-specific Project CLI state file under that worktree's Git metadata:

```text
<worktree-git-dir>/project-space/codex-owner.json
```

This state does not create a tracked or untracked file in the checkout. The claim is installed atomically, so two simultaneous tasks cannot both claim the same unowned worktree.

## Main tasks and subagents

Only the persistent main task runs `project worktree prepare`. Codex subagents have their own `CODEX_THREAD_ID`, even though they are delegated by the main task. They work under the main task's established claim and must not replace it with their subagent ID.

A side chat without `CODEX_THREAD_ID` may inspect and plan, but it cannot claim a worktree or begin implementation.

## Creating a new worktree

Branch naming is task-specific, so `prepare` deliberately does not invent a branch name. Create the branch and worktree from current `origin/main`, enter it, and then claim it:

```bash
git fetch origin main
git worktree add -b feature/my-task \
  ~/projects/.worktrees/project-space/feature-my-task \
  origin/main
cd ~/projects/.worktrees/project-space/feature-my-task
project worktree prepare
```

One persistent task may continue doing related work in its owned worktree without creating an issue for every follow-up. A different persistent task must use a different worktree.
