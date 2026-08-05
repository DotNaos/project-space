# Pull request previews

Project Space automatically builds and deploys one isolated, temporary Preview for an open pull request after its exact-revision artifact workflow succeeds. A Preview is never a Production or Beta environment and never contributes deployment truth to the project topology.

## Operator workflow

Queue the current PR head through the trusted workflow on `main`:

```sh
project deploy preview --pr 263 --format json
```

Read the VPS-verified inventory:

```sh
project deploy preview status --pr 263 --format json
project deploy preview status --all --format json
```

Remove a Preview manually when lifecycle automation needs recovery:

```sh
project deploy preview destroy --pr 263 --format json
```

The expected URL is deterministic: `https://pr-{id}.projects.os-home.net`. The CLI may print that expected URL as soon as work is queued, but the web UI exposes it as current only after the runtime, image, full PR head SHA, health checks, and `/api/app/meta` all agree.

## Trust boundary

The workflow and Preview runner are loaded from trusted `main` assets. The PR supplies application source only. Its workflow, Dockerfiles, Compose files, ignore rules, shell commands, paths, domains, and resource names are never used as deployment control input.

The public Preview gateway is also built from `main`. It reuses the existing Clerk instance and GitHub OAuth application while keeping their raw credentials outside PR-controlled containers:

- Clerk tokens are accepted only for the exact `pr-{id}.projects.os-home.net` origin.
- The gateway replaces the browser token with a short-lived identity assertion bound to repository, PR, SHA, and origin.
- A fixed allowlist of read-only GitHub and auth-session requests is brokered through the existing trusted Project Space service. Preview code cannot create, edit, or delete GitHub resources.
- Connector, machine-control, terminal, Codex, Git, platform deployment, and workspace-launch APIs are blocked in Previews.
- The PR backend gets an isolated database and a PR-scoped gateway assertion key, but no Clerk secret, GitHub token, connector credential, signing key, Production state, Docker socket, or general SSH access.

## Runtime lifecycle

Every resource name is derived from the validated positive PR number. For PR #263:

```text
URL              https://pr-263.projects.os-home.net
Compose project  project-space-preview-pr-263
Runtime root     /opt/platform/previews/project-space/pr-263
State root       /opt/platform/state/project-space-preview/pr-263
Lock             /opt/platform/locks/project-space-preview-pr-263.lock
```

An update holds the PR-specific lock, revalidates the open same-repository PR and exact head SHA, then starts immutable image digests. A failed update restores the previous verified Preview and reports it as outdated. A first deployment failure removes partial resources.

Close and merge cleanup use the same lock. Cleanup is complete only after the PR containers, internal network, database volume, runtime directory, and route are absent and a bounded tombstone records that evidence. The scheduled Reaper reconciles missed close events and expired Previews.

## Required infrastructure setup

These changes are external to application implementation and need their own operator approval before activation:

1. Route `*.projects.os-home.net` to the Preview ingress and provision trusted wildcard TLS, while the gateway admits only `pr-{positive integer}.projects.os-home.net`.
2. Configure the existing Clerk instance to accept the Preview origins; do not create a second Clerk instance.
3. Create a protected GitHub Actions environment named `Preview`, separate from `Production`.
4. Give that environment only the Preview 1Password service account, forced-command SSH identity, and required Tailscale identity. Both authorized-key entries must use OpenSSH `restrict` together with their `command=...` binding, which disables port, agent, and X11 forwarding plus PTY allocation.
5. Bind the mutating key with `restrict,command="/opt/platform/share/project-space-preview/preview-ssh-entrypoint.sh"`. Configure the local SSH alias `project-space-preview-status` from `deploy/deploy.yaml` with a separate key bound by `restrict,command="/opt/platform/share/project-space-preview/preview-status-entrypoint.sh"`. The two keys must not be interchangeable.
6. Let the normal Production workflow install each exact-main trusted runner and Compose
   release under `/opt/platform/share/project-space-preview-releases`, atomically activate
   `/opt/platform/share/project-space-preview-current`, and refresh only the two fixed
   forced-command entrypoints under `/opt/platform/share/project-space-preview`. Keep its
   configuration under `/opt/platform/config/project-space-preview.env`.

The runner configuration contains limits, not application secrets:

```text
PREVIEW_MAX_ACTIVE=3
PREVIEW_MIN_FREE_BYTES=21474836480
PREVIEW_STORAGE_BUDGET_BYTES=214748364800
PREVIEW_IDLE_SECONDS=3600
PREVIEW_GATEWAY_ENV_FILE=/opt/platform/secrets/project-space-preview/gateway.env
```

The referenced gateway environment must be a regular, non-symlink file owned by `root:preview-deploy` with mode `0640` below the Preview secret root. Docker Compose runs as the tightly restricted `preview-deploy` controller and must read this file to pass the existing Clerk server credential only into the trusted gateway container. The PR containers never mount or receive it. Never paste its values into a workflow, repository file, command argument, or log.

## Recovery checks

If a Preview is not ready, inspect the workflow result and then read status through the CLI. Do not infer success from a green build, GitHub Deployment entry, container name, or URL shape.

After cleanup, confirm all of the following before removing the tombstone:

- no labelled PR containers remain;
- the PR internal network and Postgres volume are absent;
- the runtime directory is absent;
- the Preview route no longer serves the PR build;
- the GitHub Deployment status is inactive when reporting is available;
- Production SHA and Production health evidence are unchanged.

Never use broad Docker pruning as Preview recovery.
