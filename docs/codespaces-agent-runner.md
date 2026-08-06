# GitHub Codespaces issue agent

The repository dev container bootstraps one reproducible Linux development
environment with Bun, Go, Docker, the interactive Codex CLI, and a matching
released `project`/`project-space-connector` pair. It can then start one
issue-bound Codex task without a second prompt.

This is the manual first vertical slice. It keeps the foreground connector in
a detached tmux session and allows one active task per Codespace. Run separate
Codespaces for parallel features.

## Create the Codespace

Create a GitHub Codespace from the branch that contains `.devcontainer` (or
from `main` after this change is merged) and select the **Project Space** dev
container configuration. A 2-core machine works; 4 cores make full builds and
Docker tests materially faster.

Creation runs `.devcontainer/bootstrap.sh` twice. The second run is an
idempotency check rather than a second installation. Every later container
start runs `.devcontainer/verify.sh`.

If GitHub opens recovery mode, inspect **Codespaces: View Creation Log**, fix
the reported error, and run **Codespaces: Rebuild Container**. From a recovery
terminal, the same bootstrap can be replayed safely:

```sh
bash .devcontainer/bootstrap.sh
```

## Authenticate once

Codex must use the ChatGPT subscription login. The runner removes API-key
environment variables from every child process and refuses API-key or unknown
authentication instead of silently falling back to usage-based billing.

```sh
codex login --device-auth
codex login status
```

The status must explicitly report ChatGPT. The login is kept in the Codespace
user's `~/.codex` directory; it is never written to the repository or runner
state. On a fresh Codespace, bootstrap also installs the repository's
non-secret `.codex/config.toml` as the initial global config so managed
worktrees inherit the same model, sandbox, approval, and network defaults even
before a path-specific trust entry exists. It updates only an unchanged config
that it installed itself and never overwrites a user-modified global config.
Automated credential distribution is outside this first slice.

Before starting a task, the runner checks that both the interactive CLI and the
exact managed Codex runtime bundled with the Project connector can read that
same ChatGPT login.

GitHub's preinstalled `gh` session must also be able to read and write the
repository:

```sh
gh auth status --hostname github.com
```

No personal GitHub API key is required by this runner. Repository access comes
from the Codespace GitHub session, while Project Space uses its existing
connected GitHub integration to resolve the issue and create its issue branch.

## Start an issue

From the Project Space source checkout, run:

```sh
bun scripts/codespace-agent.ts --issue 454 --detach
```

The runner performs these steps as one supervised operation:

1. verifies GitHub, ChatGPT Codex, Docker, Project CLI, and connector readiness;
2. starts `project connect --connector-mode foreground`;
3. prints a Project Space machine-approval URL on the first run and waits for
   that machine to become online;
4. calls `project codex start --issue 454 --here` with an operation ID derived
   from repository, issue, and `CODESPACE_NAME`;
5. saves only the confirmed task identity under
   `~/.local/state/project-space/codespace-agent`; and
6. keeps the connector alive inside a detached tmux session.

Once confirmed, the Codex turn is already running with the issue URL and the
repository's `AGENTS.md` rules. The issue defines the requested result; the
repository rules require coherent checks and pull-request integration while
the task prompt explicitly withholds merge, release, and deploy authority. For
the first slice in #456, the expected handoff is a linked **draft** pull
request.

The runner survives a closed VS Code terminal. Attach to its tmux session to
watch output or interact with it:

```sh
tmux -L project-space-agent attach-session -t =issue-454
```

Detach without stopping the runner with **Ctrl+B**, then **D**. Use another
terminal for development servers or inspection.

## Inspect, stop, and resume

Print the saved task identity and an exact `project codex read` command:

```sh
bun scripts/codespace-agent.ts --issue 454 --status
```

Attach to the tmux session and press **Ctrl+C** to stop the foreground connector. This
takes the machine offline but preserves its approved machine identity, Codex
login, stable operation ID, and non-secret task state.

Resume with the exact same start command:

```sh
bun scripts/codespace-agent.ts --issue 454 --detach
```

The runner recovers a stale local lock, reconnects the same Codespace, and
replays the same operation ID. Project Space returns the already-confirmed task
instead of starting a duplicate thread. A live lock prevents a second issue
from being started in the same Codespace.

Only revoke the Project Space machine identity when the Codespace should no
longer be trusted:

```sh
project disconnect --connector-mode foreground
```

## Current boundary

This slice is sufficient to dogfood issue-bound development entirely from
Codespaces, including Docker-backed tests and parallel work through one
Codespace per feature. The following remain separate follow-ups:

- GitHub App provisioning and automatic Codespace creation;
- a VPS watcher that starts tasks from assignment or workflow state;
- unattended ChatGPT credential transfer or rotation;
- Codex App Server chat and development-server access over Tailscale; and
- automatic draft-to-ready, merge, release, deployment, and teardown policy.
