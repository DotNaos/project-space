# Workspace runtimes

Workspace runtimes make repository-specific tools and services reproducible without tying their lifetime to the Git checkout. The checkout remains until a separate worktree operation removes it; runtime `stop`, `reconcile`, and `clean` never delete repository files.

## Runtime manifest

Each participating worktree contains `.project/runtime.yaml`. Version 1 is strict: unknown fields, version ranges, mutable container images, unsupported tool IDs, duplicate declarations, symlinked inputs, and unenforced process limits are rejected.

```yaml
version: 1
defaultMode: process
credentialScope: workspace-generation
projectProtocol: 1
projectRuntime:
  id: project
  version: 0.5.0
  sha256: <exact executable sha256>
codex:
  id: codex
  version: 1.2.3
  sha256: <exact executable sha256>
toolchains:
  - id: bun
    version: 1.2.20
    sha256: <exact executable sha256>
inputs:
  - bun.lock
setup:
  - dependencies
startup: []
shutdown: []
devServers:
  - prototype-desktop
ports:
  - id: prototype
    devServer: prototype-desktop
    protocol: tcp
resources:
  cpuMillis: 0
  memoryMiB: 0
  pids: 0
```

Setup, startup, shutdown, and dev-server names refer to finite declarations in `.project/scripts.yaml`; the runtime manifest cannot introduce free-form shell commands. Process mode currently accepts only zero resource limits because it cannot yet prove cgroup-style enforcement. Devcontainer mode uses a separate strict JSON declaration with a digest-pinned image, a non-root user, `/workspace`, and no mounts, lifecycle hooks, features, host networking, privileged mode, or Docker socket.

## Lifecycle

Use the local CLI against a Project-managed Worktree:

```text
project workspace runtime inspect --json
project workspace runtime start --expected-commit <commit> --expected-digest <digest> --json
project workspace runtime suspend --expected-generation <generation> --json
project workspace runtime resume --expected-generation <generation> --json
project workspace runtime stop --expected-generation <generation> --json
project workspace runtime clean --expected-generation <generation> --json
project workspace runtime reconcile --expected-generation <generation> --json
```

`project worktree prepare` assigns the linked worktree one immutable UUID Workspace ID. That identity survives path moves and is shared with the control plane; recreating the runtime changes only its generation. `start` reuses an already healthy generation only when the Workspace identity, commit, manifest digest, and runtime mode still match. Every mutating follow-up requires the exact generation. A changed or incomplete process, tmux, port, or container observation fails closed.

```mermaid
flowchart LR
  A["Managed Git worktree"] --> B["Strict manifest and pinned tools"]
  B --> C["Persist generation and ownership proof"]
  C --> D["Launch process or container driver"]
  D --> E["Verify every owned resource"]
  E --> F["Running"]
  F --> G["Suspend or stop"]
  G --> H["Re-verify before each mutation"]
  H --> I["Stopped"]
  I --> J["Clean generation state only"]
```

The process driver launches the exact checksum-verified Codex App Server on a private Unix socket whose live owner must remain in the recorded process group. It creates a private HOME and `CODEX_HOME` inside the generation state directory and does not inherit ambient credentials. The container boundary uses an immutable container ID plus exact Workspace, generation, manifest, image, and ownership labels. A container driver is deliberately pluggable; there is no fallback from a requested container runtime to process mode.

The root-owned SSH control-gateway identity can register bounded mappings from a Workspace ID to its Project-managed Worktree. The machine-authenticated HTTP boundary and the pinned private-network SSH transport accept only that ID plus the expected commit, manifest digest, mode, generation, and operation ID. The same authorization and durable replay fence used by `status.v1` protect the runtime operations. The remote gateway invokes the same manager and never accepts caller-selected shell commands or host paths. Public results omit ownership tokens, credentials, logs, and raw provider data.

## Validation obligations

- If an exact healthy generation is started twice, the second start returns the same generation without launching another runtime.
- If a process, container, socket, dev-server session, state directory, or generation proof is missing, replaced, foreign, or ambiguous, no foreign resource is mutated.
- If a crash happens around a dev-server start or stop, the persisted intent plus the complete Project Serve inventory either reconstructs the exact owned resource or proves it absent; otherwise reconciliation remains blocked.
- If `stop` and `clean` succeed, the generation leaves the active namespace and a bounded, secret-free terminal ownership tombstone records its proof-bound retained archive; no name-based recursive deletion can reach a replacement object. The managed Worktree, its Git metadata, and unrelated processes remain unchanged.
- If an SSH request is retried with the same operation ID and bindings, the durable result is replayed without a second dispatch. A changed binding is rejected.

The deterministic proof is split across `go test ./internal/workspacerun ./internal/projectrun`, the race variants of those packages, the SSH control-gateway contract tests, and the database migration tests. `TestRealProcessRuntimeLifecyclePreservesNeighborAndCheckout` is the representative local process-mode run: it builds the current Project CLI, launches the installed pinned Codex App Server, walks start, inspect, suspend, resume, stop, and clean, and checks the neighboring process and checkout afterward. It needs no 1Password credential. A real container engine is optional infrastructure; the provider-neutral container lifecycle and strict digest-pinned fixture remain deterministic contract tests when Docker or Devcontainer is unavailable.
