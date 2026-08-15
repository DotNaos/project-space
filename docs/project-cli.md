---
title: Project CLI Reference
description: Commands and workflows for the Project CLI.
---

The `project` CLI is the local command-line interface for Project. It calls the same Project functionality that is also exposed through API surfaces.

## Prepare An Isolated Codex Worktree

```sh
project worktree prepare <task-name>
project worktree prepare --issue <number>
project worktree prepare <task-name> --format json
project worktree check
project worktree check --format json
```

Every repository mutation runs on a dedicated branch in
`~/projects/.worktrees/{project}/{branch}`. Issues are optional, but larger tasks
should normally use `--issue`. The current `CODEX_THREAD_ID` owns the prepared
worktree through worktree-specific Git configuration, so the ownership metadata
does not dirty the checkout.

`check` fails in the shared default-branch worktree, outside the standard path,
without a Codex thread ID, in unmanaged worktrees, and when a different Codex
thread owns the current worktree. The same chat may reuse its existing worktree
for multiple related changes.

See [Codex Worktree Ownership](./codex-worktrees.md) for the complete workflow
and collision rules.

## Discover And Open Projects

```sh
project list
project list --format json
project path <project>
project open <project>
```

`list` starts with repositories visible to the connected Project Space account,
then reports which ones have a verified checkout on the current machine.
`path` accepts a unique repository name, exact `owner/name`, or stable
`github:<id>` selector and prints only the canonical local directory by default.
Neither command clones or changes a checkout.

`open` passes that verified directory directly to the operating system's
terminal launcher. It does not run a project script or any command from the
repository. macOS uses the user's Launch Services shell-script handler. Windows
starts a new console in the directory so the configured default terminal host
receives it. Linux uses `xdg-terminal-exec` when available, then the documented
`x-terminal-emulator` fallback; headless systems and systems without either
launcher fail explicitly. Human and JSON output identify the selected launcher
and whether it was the system selection or a fallback.

Generated shell completion discovers the same account projects dynamically.
When the service is briefly unavailable, completion may use a credential-scoped
cache for up to one minute. Cached suggestions say that local availability is
unverified; `list`, `path`, and `open` never use this completion fallback.

## Create A Project

```sh
project new <directory>
```

`new` is an alias for `create`.

Useful flags:

```sh
--template <owner/repo>
--template-path <path>
--version <version>
--commit <commit-or-label>
--force
--github
--github-visibility <private|public>
--tmp
--local-tmp
--global-tmp
--target <target>:<device>[,<device>...]
```

`--tmp` creates `./tmp/generated-app-<suffix>`, writes tmp template values, and installs the template's default modules.

`--local-tmp` is the explicit form of `--tmp`.

`--global-tmp` creates the generated project under `/tmp` with a random suffix.

Templates that declare selectable app targets require one `--target` value per
target. Each value names the target and its exact device set. Omitted targets
and devices are not generated, and no fallback device is inferred. A valid
selection installs the shared default modules plus only the selected targets.

```sh
project new my-app --target web:desktop,mobile
project new my-app --target native:mobile
project new my-app --target web:desktop,tablet --target native:mobile
```

`--github` initializes Git, creates a private GitHub repository by default with the implicit `gh` owner, commits the project, and pushes `main`.

GitHub repositories are private by default. Use `--github-visibility public` to create a public repository.

`--github` does not create or store any secret-delivery credential. CI identities
must be fixed and provisioned separately for the exact repository and environment.

When `--template-path` and `PROJECT_SPACE_TEMPLATE_ROOT` are omitted, `project new`
fetches the GitHub template named by `--template`. If `--template` is omitted,
it uses `DotNaos/project-template`.

Example:

```sh
project new \
  --template DotNaos/project-template \
  --template-path . \
  --version local \
  --commit local \
  --tmp
```

Named local tmp project:

```sh
project new my-app --tmp
```

Named global tmp project:

```sh
project new my-app --global-tmp
```

## Initialize An Existing Project

```sh
project init [directory]
```

If `[directory]` is omitted, the CLI uses the current directory.

## Plan Existing Project Adoption

```sh
project adopt [directory]
project adopt [directory] --format json
project adopt [directory] --module <name>
project adopt [directory] --module <name> --yes
project adopt [directory] --waive <path-pattern> --reason <text>
project adopt [directory] --waive <path-pattern> --reason <text> --yes
```

Without an action flag, this is read-only. It classifies files as matching the
template, missing from the project, changed from the template, allowed by a
slot, or unknown to the template. Template-defined blockers, such as plaintext
secret files, are always reported before ignored paths or slots are pruned.
Files ignored by the template are otherwise left out of the adoption noise.

`--waive` records tracked adoption debt in `.project/template.lock.yaml`.
Waivers require a reason and cannot cover blocker files.

`--module` adopts a template module for an existing project. It adds only
missing template-owned files, never overwrites existing files, and records the
module in `.project/template.lock.yaml`. Dependency modules are adopted with the
requested module.

## Diagnose The Current Machine

```sh
project doctor
project doctor --format json
```

Doctor checks the current Machine Credential and local project directories.
Remote Connector diagnosis and repair are retired and fail closed rather than
restarting, updating, or dispatching through a legacy service. Runtime health
is inspected through the exact Environment and Workspace Runtime lifecycle.

See the [Project Doctor guide](/docs/cli/doctor) for the
state model and safety boundaries.

## Update The Project CLI And Codex Host

```sh
project self-update --check
project self-update
project self-update --yes
project self-update --format json
project self-update --format json --yes
```

`self-update` checks the signed stable release manifest and keeps the Project
CLI and Codex host on one matching machine-tools release. The default command
shows the verified plan and asks for `y/N` confirmation. `--check` is always
read-only, while `--yes` installs without prompting. JSON output never prompts;
it is read-only unless `--yes` is also present.

Normal interactive commands reuse a private cached result and refresh the
signed approved release check in the background after 24 hours. A known newer
compatible release is reported on interactive stderr with the current version,
target version, and `project self-update` command. Failed checks are silent and
retry after 15 minutes. Pipes, redirected output, JSON automation, completion,
help, and `self-update` remain clean. Set `PROJECT_CLI_NO_UPDATE_CHECK=1` to
disable these automatic read-only checks. This never downloads or installs a
release in the background.

Only a managed macOS arm64 or Linux x64/WSL installation is changed in place.
The updater downloads the exact archive named by the signed manifest, verifies
its size and SHA-256 checksum, and delegates the switch to the existing
installer. The installer does not start a permanent Connector. Machine identity
and credentials remain outside the release directory.

Homebrew, native Windows, source-checkout, and unrecognized installations are
reported without being overwritten. The result includes the appropriate
package-manager, installer, or rebuild guidance. Installation remains strictly
user-invoked; Project never performs silent or background updates.

## Read And Update The Issue Roadmap

```sh
project roadmap
project roadmap --verbose
project roadmap --format json
project roadmap --repository DotNaos/project-space
project roadmap dependency add 412 --requires 298
project roadmap dependency remove 412 --requires 298
```

The default roadmap output keeps deterministic root-to-leaf paths, dependency
arrows, issue state tokens, branches, joins, roots, and standalone nodes.
`--verbose` prints each issue on its own line with its title and a normalized
single-line description. Markdown and multiline descriptions are collapsed for
terminal display, empty descriptions are called out explicitly, and long
details are truncated to the current terminal width. JSON keeps the canonical
title and visible issue description and is not changed by `--verbose`.

Shell completion reads issue numbers, titles, and descriptions through the
connected Project Space server. Completion for the positional issue and
`--requires` never falls back to local filenames. Remove completion only offers
relationships that currently exist.

When either issue value is omitted in an interactive terminal, `add` and
`remove` open a searchable issue table. Add chooses the dependent issue first
and then its prerequisite. Remove only offers prerequisites already attached to
the selected issue. Escape cancels without changing the roadmap. Scripts and
other non-interactive callers must provide both numeric values; the command
fails immediately instead of waiting for input.

All reads and writes use the same server-owned roadmap and issue data as
Project Space. Dependency updates still enforce the current graph revision,
freshness, permissions, cycle checks, relationship validity, and manual plan
order on the server.

## Run And Serve Project Scripts

Projects declare finite commands separately from long-running servers in
`.project/scripts.yaml`:

```yaml
version: 3
setup:
  - id: dependencies
    command: [bun, install, --frozen-lockfile]
commands:
  test:
    command: [bun, test, --isolate]
  build:
    command: [bun, scripts/build-project.ts]
servers:
  dev:
    label: Project Space
    command:
      - bun
      - x
      - vite
      - --host
      - "{host}"
      - --port
      - "{port}"
      - --strictPort
    environment:
      VITE_PROJECT_SPACE_API_BASE_URL: http://127.0.0.1:45873
      VITE_PROJECT_SPACE_AUTH_DISABLED: "1"
      PROJECT_SPACE_AUTH_DISABLED: "1"
      PROJECT_SPACE_PUBLIC_ORIGIN: ""
    secretEnvironment:
      GITHUB_OAUTH_CLIENT_ID: infisical://d786940c-96a1-4937-981a-dc8729effcf4/dev/GITHUB_OAUTH_CLIENT_ID
    healthCheck:
      path: /
      timeoutSeconds: 45
```

`command` is always an argument list. It is never passed through a shell.
`{host}` and `{port}` are replaced before the process starts. The same values
are also available as `PROJECT_HOST` and `PROJECT_PORT`. Schema version 3 is
the capability boundary: an older Project CLI that does not understand the
separate `commands` and `servers` sections rejects the file instead of falling
back to a package script.

Use `environment` for ordinary configuration and `secretEnvironment` for
`infisical://<project-id>/<environment>/<secret-name>` references. A secret
declaration is resolved by one exact `infisical secrets get` request with
imports and recursion disabled. The declaration and protected runtime request
contain only the reference; the resolved value exists in resolver process
memory and the child environment. This is repeated on every managed restart.
Project CLI rejects plaintext values, mixed project scopes, and keys duplicated
across the two sections.

Project Space's `dev` server deliberately declares its database-free local
preview profile: `PROJECT_SPACE_AUTH_DISABLED=1`,
`VITE_PROJECT_SPACE_AUTH_DISABLED=1`, and an explicitly empty
`PROJECT_SPACE_PUBLIC_ORIGIN`. The two auth flags keep the server and browser
on the same local-auth mode. `PORTLESS_URL` remains the browser-facing local
address, but it cannot implicitly enable the database-backed machine runtime.
The default profile is a self-contained local simulation. It does not load the
GitHub OAuth client ID or any other provider secret.

These workflows require the installed `project` executable on `PATH`. A missing
or older CLI is an explicit setup error; package-manager scripts are not a
development-server fallback.

Run a script in the foreground, like `bun run`:

```sh
project run test --format json
project run build <directory>
```

`project run` inherits the current terminal environment. In JSON mode, child
output goes to stderr and the final result is printed as one JSON object on
stdout. A server name is not accepted by `project run`; it must enter the
managed lifecycle through `project serve`.

Run a managed dev server with an explicit backend binding:

```sh
project serve
project serve --apis simulated --data local
project serve --apis external --data local
project serve --apis external --data remote
project serve --tailnet
project serve --no-tailnet
project serve dev <directory>
project serve dev <directory> --allowed-host preview.example.com
project serve status <directory> --script dev --json
project serve list --json
project serve list <directory> --configured --json
project serve logs <directory> --script dev
project serve logs <directory> --script dev --follow
project serve attach <directory> --script dev
project serve stop <directory> --script dev --json
project serve reconcile --json
```

`project serve` defaults to the `dev` script, current directory,
`--apis=simulated`, and `--data=local`. The default starts a stateful local
simulation of provider APIs, stores its scenario state outside the repository,
and blocks outbound network connections. It does not require internet access,
a hosted database, an external account, an API key, or an external secret. If
its only positional argument is an existing directory, it runs `dev` there.

The supported backend combinations are:

| APIs | Data | Startup behavior |
| --- | --- | --- |
| `simulated` | `local` | Default self-contained local simulation. |
| `external` | `local` | Reserved for real integrations with isolated local data. |
| `external` | `remote` | Reserved for real integrations with the configured shared database. |
| `simulated` | `remote` | Rejected before startup. |

External modes currently fail closed because secure service-account token
delivery to the detached server has not been finalized. A raw token is never a
CLI option. Remote data must never be migrated, seeded, reset, or otherwise
mutated automatically during startup.

API and data options select only the backend composition. They do not choose
where the server can be reached. Plain `project serve` publishes its verified
listener through Tailscale while still using simulated APIs and local data by
default. `--no-tailnet` is the explicit network opt-out and keeps the server on
the current machine. `--tailnet` remains a compatible explicit statement of
the default. The older `--local-only` spelling is a deprecated alias for
`--no-tailnet`; neither opt-out can be combined with `--tailnet`.

Simulation state is stored per managed worktree at
`<Project Space serve state>/simulations/<server-id>.json`. On macOS the serve
state root is `~/Library/Application Support/Project Space/serve`; on Linux it
is `$XDG_STATE_HOME/project-space/serve` or
`~/.local/state/project-space/serve`. The directory and file are owner-only.
Use **Reset scenario** from the single **Local simulation** indicator in the app
to restore the deterministic starting state for that worktree.

Existing `project serve dev` users now receive simulated APIs and local data by
default. Workflows that need real GitHub, Codex, machine, or shared-database
integration must choose an external binding explicitly; those modes remain
blocked until secure detached credential delivery is implemented.

Managed servers listen on a free `127.0.0.1` port. The CLI registers one exact
Portless alias such as `http://612-managed-dev.project-space.localhost:1355`
for normal local use. When the separate Tailnet transport is enabled, it also
creates one exact raw Tailscale TCP route and reports a DNS-free URL such as
`http://100.80.135.9:44000`; MagicDNS and Tailscale certificate domains are not
required. Stop removes only the recorded Portless alias and any owned Tailscale port when
their current targets still match the recorded local server. It never resets
unrelated Portless or Tailscale routes, and it never stops the shared Portless
proxy.

Each canonical worktree and server name has one deterministic identity and one
owned tmux session. Repeated starts reuse the healthy session, while different
worktrees and server names receive independent sessions and collision-free
ports and Portless names. The session survives the terminal or Codex task that launched it.
`status`, `logs`, `attach`, `stop`, and `reconcile` resolve that same identity;
they refuse to mutate a tmux session, Portless alias, or Tailscale route whose ownership evidence
no longer matches the persisted generation.

Tailnet mode is fail-closed. A start is not `running` until the tmux process,
local listener, exact Portless alias, exact Tailscale route, and direct,
Portless, and Tailnet health checks all
agree. If publication fails, the CLI compensates the resources created by that
start and reports `failed`. It never silently leaves a local server running.
The default local-only mode reports `local-only` and never returns a public URL
or attempts a Tailnet fallback.

`--allowed-host` is repeatable and accepts explicit hostnames or IP addresses
only. Every validated value is available to project tooling in the
comma-separated `PROJECT_ALLOWED_HOSTS` variable. For compatibility, the Vite
`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` variable is also set when exactly one
extra host is configured; Vite interprets a comma-separated value as one
literal hostname. Raw Tailscale IPv4 URLs normally do not need an extra Vite
host entry.

If `healthCheck` is configured, the direct listener, Portless URL, and Tailscale URL must return a
2xx or 3xx response before the session becomes `running`. Without it, the CLI
checks each TCP listener. In both cases, it also verifies that the selected port
belongs to the managed process group. The globally installed `portless`, plus
`tmux` and `lsof`, must be available in the selected Workspace Runtime.
`tailscale` is
required only for Tailnet transport.

The managed process receives a small allowlist of runtime and toolchain
environment variables. Connector registration tokens, Clerk keys, database
URLs, and other server secrets are not inherited. A private supervisor inside
the owned tmux session keeps a bounded 64 KiB log tail outside the worktree.
Startup failures include a short, sanitized tail in `lastError`; the CLI never
creates an unbounded project log.

Session state and locks live in the current operating-system user's durable
state directory, outside the worktree (`~/Library/Application Support/Project
Space/serve` on macOS or `$XDG_STATE_HOME/project-space/serve`). A session is
identified by the canonical Git repository, canonical worktree, and server key.
App-user ownership and access remain in Project Space's database; the
machine-local state contains only the generation-scoped tmux, process, listener,
Portless alias, and route identity. `project serve reconcile` checks all
recorded sessions one at a time and leaves foreign or ambiguous resources
untouched.

Machine-readable serve output always contains the same fields:

```json
{
  "schemaVersion": 2,
  "operation": "start",
  "disposition": "created",
  "mode": "managed",
  "apis": "simulated",
  "data": "local",
  "secrets": "none",
  "serverId": "project-serve-project-space-dev-a81f2c3d4e5f",
  "serverKey": "dev",
  "script": "dev",
  "directory": "/absolute/worktree",
  "repository": "/absolute/repository/.git",
  "tmuxSession": "project-serve-project-space-dev-a81f2c3d4e5f",
  "capability": "configured",
  "state": "running",
  "pid": 7001,
  "localPort": 43117,
  "localUrl": "http://worktree.project-space.localhost:1355",
  "portlessName": "worktree.project-space",
  "publicPort": 44000,
  "publicUrl": "http://100.80.135.9:44000",
  "tailscaleIPv4": "100.80.135.9",
  "allowedHosts": [],
  "startedAt": "2026-07-11T12:00:00Z",
  "checkedAt": "2026-07-11T12:00:01Z",
  "lastError": null
}
```

`capability` is `configured` or `unavailable`. Runtime `state` is `stopped`,
`starting`, `running`, `local-only`, `stopping`, `failed`, or `stale`. Start
`disposition` is `created` or `reused`. Nullable runtime fields remain present
so connector clients can decode one stable shape. `localUrl` is the stable
Portless address while `localPort` retains the verified direct listener for
diagnostics; `publicUrl` is always null in
local-only mode.

## Deploy

```sh
project deploy --env prod
project deploy --env prod --commit <full-current-main-sha>
project deploy --env beta
project deploy --env prod --dry-run --format json
project deploy status --env prod
project deploy status --all-envs --format json

# Pull request previews are dispatched only through the trusted main workflow.
project deploy preview --pr 263 --format json
project deploy preview status --pr 263 --format json
project deploy preview status --all --format json
project deploy preview destroy --pr 263 --format json
```

`project deploy` uses the existing template compose files:

- `deploy/compose.yml` and `deploy/ingress.labels.yml` for this app.
- The VPS-owned `private-platform-traefik` ingress and `traefik-public` Docker network.

Configuration can live in `deploy/deploy.yaml`:

```yaml
host: deploy@100.84.238.75
preview:
  statusHost: project-space-preview-status
secrets:
  EXAMPLE_API_KEY: infisical://00000000-0000-4000-8000-000000000000/prod/EXAMPLE_API_KEY
environments:
  prod:
    default: true
    branch: main
    path: /opt/platform/apps/my-project
    domain: my-project.os-home.net
    apiDomain: api.my-project.os-home.net
  beta:
    branch: beta
    path: /opt/platform/apps/my-project-beta
    domain: beta.my-project.os-home.net
    apiDomain: api.beta.my-project.os-home.net
```

Only `prod` and `beta` are supported. The old flat `deploy/deploy.yaml`
shape is not supported.

`preview.statusHost` is a dedicated SSH alias for verified Preview inventory.
The CLI sends only `status-all` to that host. Configure its separate key with
`deploy/preview-status-entrypoint.sh` as the server-side forced command; do not
reuse the deployment key.

Deploy status and dry-run JSON include clickable URLs for the app, API, and
docs. The docs URL is derived from the app domain at `/docs`.

Flags override config. Values from `deploy/deploy.yaml` are used directly,
without confirmation prompts. Secret values are read from Infisical only for
real deploys; dry-runs show only secret references.

Production deploys resolve one full Git SHA and re-check it against current
`origin/main` both before connecting and again while holding the VPS deployment
lock. The lock at `/opt/platform/state/project-space-prod/deploy.lock` is kept
inside the Production environment's private state directory and covers checkout,
container replacement, verification, and any rollback. A successful JSON result
contains matching remote-checkout, running-build, image, service-health, HTTP,
and live-origin evidence. A failed rollout restores only the atomically recorded
last verified commit and verifies that rollback before returning.

The `Deploy production` GitHub Actions workflow validates every new `main`
commit without production secrets, then deploys that exact SHA through the
GitHub `Production` environment. See
[Production deployment](production-deployment.md) for workflow recovery,
failure states, secret configuration, and the safe disable procedure.

Pull request previews use `.github/workflows/deploy-preview.yml` from `main`.
The CLI first proves the GitHub origin, an open same-repository PR targeting
`main`, its full head SHA, and the caller's write permission. It then dispatches
only the PR number, a random operation ID, and the requested action to the
trusted workflow; it never executes deployment code from the PR branch.

The deploy response contains an `expectedLiveUrl`, not proof that the preview
is live. Use `project deploy preview status` for verified VPS state. A ready
preview is served at `https://pr-<number>.projects.os-home.net`. `destroy` is a
manual recovery command; merged and closed PRs are normally cleaned up by the
trusted workflow.

Preview status JSON has one stable top-level inventory:

```json
{
  "checkedAt": "2026-07-22T10:03:00Z",
  "previews": [{
    "repositoryFullName": "DotNaos/project-space",
    "pullRequestNumber": 263,
    "requestedSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "runningSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "liveUrl": "https://pr-263.projects.os-home.net",
    "state": "ready",
    "verifiedAt": "2026-07-22T10:02:00Z",
    "updatedAt": "2026-07-22T10:02:00Z"
  }]
}
```

PR URL, head branch, running SHA, live URL, timestamps, and message are omitted
when the trusted registry has no evidence for them. `requestedSha` can also be
absent for an idempotent `removed` or `absent` result that never deployed.

Canonical Runtime commands are authenticated and fenced by the owner-bound
Machine Credential, exact Environment and Workspace identity, runtime
generation, and durable operation ledger. They do not reuse a retired
Connector registration token or Connector command-signing key.

## Project Chat

Codex tasks use the authenticated Workspace Runtime identity to leave low-priority
coordination notes in `#general`:

```sh
project chat names
project chat claim Athena

project chat claim Turing --parent-thread <main-agent-thread-id>
project chat send "The migration is ready for review."
project chat read
```

Codex supplies `CODEX_THREAD_ID`; callers do not copy or pass their task ID as
a command argument. Main agents choose an available mythology name. Specialist
threads choose an artist, science, or detective name and identify their parent
main-agent thread. The server atomically enforces availability and role within
the authenticated account and project; a local environment name cannot claim or
replace a registry name. The current task title remains descriptive metadata.
The Environment Instance, Workspace, backend URL, and authorization come only
from the authenticated canonical Environment and Workspace Runtime flow.

`send` appends one idempotent message to `#general`. `read` prints unread pages
with `Message from`, role, origin task ID, host, machine, timestamp, and a quoted
plain-text body. It advances the read cursor only after the full page has been
written successfully, so a failed output is repeated rather than lost.

The runtime backend may use HTTPS or an explicit loopback URL. The command
rejects remote plain HTTP, redirects, a missing Environment Runtime identity,
missing agent identity, and malformed Codex task IDs. It never reads old
Connector configuration or registration-token environment variables as a
fallback. Messages and profile metadata that look like credentials are
rejected before storage.

## Sync Template Snapshot

Project template commands expect local template state in the project:

```text
.project/template.lock.yaml
.project/template/
.project/template.values.yaml
```

`project init` and `project create` create this state. Normal template commands use it automatically, so no template path is needed.

```sh
project template sync
project template sync --dry-run
project template sync --dry-run --format tsv
```

The project path is optional and defaults to the current directory.

`--template-path` is only needed when testing against a local template checkout instead of the template source recorded in the project lock.

For `project init`, `project new`, and template sync/update commands, local
sources are resolved in this order: `--template-path`, then
`PROJECT_SPACE_TEMPLATE_ROOT`, then the GitHub repository recorded in
`.project/template.lock.yaml`.

Fetched templates are cached under the user cache directory at
`project-space/templates/<owner>/<repo>/<commit>/`. Set
`PROJECT_SPACE_TEMPLATE_CACHE` to use a different cache directory.

## Template Placeholders

Template files use `{{ ns.key }}` placeholders, such as `{{ project.slug }}`.

Boolean template values can also guard complete lines or blocks. `#if` keeps a
block when a value is true; `#unless` keeps it when the value is false.
Directives must appear on their own line and may be nested:

```text
{{#if app.targets.web}}
web target content
{{/if}}
```

A `$` immediately before `{{` escapes the placeholder and keeps it as literal text. Use this for GitHub Actions expressions such as `${{ github.ref }}`.

## Lint A Template

```sh
project template lint --template-path <template-directory>
project template lint --template-path <template-directory> --format json
```

This validates a template checkout without generating a project. It checks the
manifest, module files, ownership coverage, placeholder declarations, default
values, slot files, `.templateignore`, and reverse-rendering self values.

## Update From Template

```sh
project template update --dry-run
project template update --dry-run --format tsv
project template update --yes
project template update --template-path <template-directory>
project template update --target web:desktop,tablet,mobile --dry-run
```

This updates a project from its template. It prints the plan first. Use
`--dry-run` to preview without writing, or `--yes` to apply without prompting.

For changed template-owned files, the update uses a three-way merge:

- clean files are replaced with the new rendered template version.
- independent local edits are merged and shown as `merged`.
- overlapping edits are written with conflict markers, and the original local
  file plus both template sides are copied to `.conflicts/<update>/`.

`--template-path` is only for testing an update against a specific local template checkout. Normal use reads the source from `.project/template.lock.yaml`.

When a template splits or renames an installed module, the update requires an
explicit `--target <target>:<device>[,<device>...]` selection. The selection is
used to choose the replacement target modules; it is shown in the update plan
and written to the lock only when the update is applied.

## Smoke Test A Template

```sh
project template smoke --template-path <template-directory> --version local --commit local --target web:desktop,mobile
project template smoke --template-path <template-directory> --version local --commit local --target native:mobile --skip-checks
project template smoke --template-path <template-directory> --version local --commit local --target web:desktop --skip-checks --container
```

This creates a generated tmp project, installs default modules, validates it, and runs the generated project's normal checks.

Use `--container --skip-checks` for a focused generated-container smoke test.

Use `--skip-secrets-doctor` only when a generated template has no secret-doctor command available.

## Modules

```sh
project module list [directory]
project module show <module> [directory]
project module add <module> [directory]
project module add <module> [directory] --dry-run
project module add <module> [directory] --yes
project module remove <module> [directory]
project module remove <module> [directory] --dry-run
project module remove <module> [directory] --yes
project module add <module> [directory] --dry-run --format tsv
project module remove <module> [directory] --dry-run --format tsv
```

`module add` prints the planned changes, then asks for confirmation.

Use `--dry-run` to only preview changes.

Use `-y` or `--yes` to apply without prompting.

`module install` is kept as an alias for `module add`.

## Validate

```sh
project validate [directory]
project validate [directory] --format tsv
project validate --quarantine --dry-run
project validate --quarantine --yes
```

`--quarantine` moves `not_allowed` file violations into `.project/quarantine/<original-path>`.

The quarantine directory is ignored by template validation but is not ignored by Git, so quarantined files can be reviewed and committed.

Paths waived through `project adopt --waive` are reported as `WAIVED` and do not
fail validation. Template-defined blockers still fail validation even if a lock
file was edited manually to waive them.
