# Infisical secret delivery inventory

This inventory records secret consumers and ownership boundaries without secret
values. It is evidence for issue #754 and must be updated when a consumer or
identity changes.

## Project Space boundaries

| Consumer | Infisical project and environment | Authentication | Delivery | Status |
| --- | --- | --- | --- | --- |
| Local Project CLI development | `project-space` / `dev` | Signed-in human CLI session in the macOS Keychain | `infisical run` from the checked-in `infisical://` reference | Implemented and locally tested |
| GitHub Preview deploy and reaper | `project-space-preview` / `staging` | Fixed identity `5eaeaafe-2b13-4ca2-9506-4c914924e5b6`; GitHub OIDC subject `repo:DotNaos/project-space:environment:Preview`; 15-minute token | Pinned `Infisical/secrets-action` exports only root-folder, non-imported, non-recursive job environment variables | Implemented in PR #755; trusted non-deploying run 31894189550 passed on exact `main` |
| GitHub Production deploy | `project-space-production` / `prod` | Fixed identity `454fcc36-3e86-4c9f-b25d-e581d342bc36`; GitHub OIDC subject `repo:DotNaos/project-space:environment:Production`; 15-minute token | Pinned action exports only root-folder, non-imported, non-recursive job environment variables | Implemented in PR #755; trusted non-deploying run 31894189550 passed on exact `main`, and no deployment may run before exact-revision approval |
| Release-manifest signer | `project-space-release-signing` / `prod` | Fixed identity `577f6b4c-943b-4bf5-94ac-07140f1e5b2d`; GitHub OIDC subject `repo:DotNaos/project-space:environment:release-signing`; 15-minute token | Pinned action exports only root-folder, non-imported, non-recursive variables in the isolated no-checkout signer job | Implemented in PR #755; trusted non-deploying run 31894189550 passed on exact `main` |
| Manual `project deploy` | Referenced project and environment from `deploy/deploy.yaml` | Signed-in human CLI session | Environment override first, otherwise one `infisical secrets get` call per declared name | Implemented and unit tested |
| Runtime SSH control gateway | Process environment supplied at application start | Same workload boundary as the server process | `env://NAME`; no per-request CLI or subprocess | Implemented; retired `op://` database rows are disabled and blocked by migration `0054` |
| JetKVM and machine-power provisioning | `project-space-vps` / `prod` | Signed-in operator, or the fixed VPS identity after separate approval | `infisical run` injects named variables for the bounded provisioning process | Implemented; no unattended VPS credential exists |
| VPS application runtime | `project-space-vps` / `prod` | Fixed identity `b6599fb1-c962-4c0c-b153-e51bc73b7f7a` | Intended process environment injection | Secrets migrated; authentication deliberately not provisioned yet |

All Infisical projects above use delete protection. The current plan does not
permit custom project roles, so ownership boundaries use separate projects and
the built-in read-only viewer role instead of sharing one broad project. The
GitHub identities are bound to exact repository, environment subject, audience,
owner, and repository claims. No repository workflow creates an Infisical
identity, client secret, or token.

## Secret name inventory

The migration and verification paths compare values in process memory and print
only names, counts, and match results.

| Project | Environment | Names present |
| --- | --- | --- |
| `project-space` | `dev` | `GITHUB_OAUTH_CLIENT_ID` |
| `project-space-preview` | `staging` | `SSH_PRIVATE_KEY`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` |
| `project-space-production` | `prod` | 11 names: deploy SSH/Tailscale, Clerk, GitHub OAuth application, release public key, rate-limit, MQTT provider, and Vite Clerk |
| `project-space-release-signing` | `prod` | `PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64` |
| `project-space-vps` | `prod` | 15 names: application runtime, machine-power MQTT, JetKVM SSH/Tailscale provisioning, and the VPS Cloudflare DNS challenge token |
| `local-development` | `dev` | Shared development, Apple/EAS recovery, release recovery, and MCP credentials; consumers declare only the names they require |

Each migrated secret has a 90-day review reminder. Secret values are not stored
in repository files, workflow inputs, command arguments, shell snapshots, or
this inventory.

Production deliberately has no global GitHub access token. Signed-in users use
their own stored Project Space OAuth connection for private GitHub operations,
while public release metadata is fetched anonymously. This avoids keeping a
broad personal GitHub CLI token in either Infisical or the application runtime.

## 2026-08-15 credential rotation evidence

An accidental diagnostic command exposed seven migrated values. Every exposed
runtime or provider credential was replaced before the old value was retired:

- Clerk has one fixed, dated replacement key. Its API check passed, Production
  was restarted on the unchanged `afadb19e2b614a0e970475602f38a9e724dc3043`
  revision, the running value matched Infisical in memory, authenticated browser
  use passed, and the old Clerk key was deleted after email verification.
- Later legacy 1Password deployments at `bbb325eabaa3968bd7c825401d76fcb9be78fea8`
  and `5a5f6f730b584c110cc88cdd0332bef12c82fd23` each replaced that valid Clerk
  value with the retired invalid value and caused Clerk backend HTTP 401. Incident
  #772 restored Production at exact commit `5a5f6f730b584c110cc88cdd0332bef12c82fd23`
  and version `v0.24.3` through the normal locked deployment transaction using
  validated Infisical values. The running container then probed Clerk with HTTP
  200 and existing sessions were accepted. This recovery does not deploy PR #755;
  it proves that the normal workflow must stop reading the legacy provider.
- The JetKVM Tailscale OAuth client is restricted to Auth Keys write access for
  only `tag:jetkvm`. Token exchange and the read-only provisioner passed, and the
  old client is visibly revoked.
- The dedicated JetKVM SSH key was regenerated, installed as the device's sole
  authorized key through its cloud terminal, and removed from local temporary
  storage after an Infisical-backed provisioner run reported `changes: []`.
- Both exact MQTT identities received independent generated passwords. The
  broker password file, JetKVM configuration, Infisical projects, and Production
  runtime were updated; exact-topic authorization and a fresh physical-power
  status from JetKVM passed.
- The machine rate-limit secret was regenerated in memory, written to both
  required Infisical projects, and matched the restarted Production container.
- The exposed broad GitHub CLI OAuth token is no longer present in either
  Infisical project or the Production container. Production uses the signed-in
  user's stored Project Space OAuth connection; a real catalog refresh reported
  100 repositories. Provider-side invalidation still requires revoking the
  account-wide GitHub CLI grant, which can also sign out unrelated `gh` clients,
  so that broader user action remains an explicit final gate.

The Cloudflare DNS challenge token was not exposed. It was migrated from the
legacy Traefik environment file into `project-space-vps`, verified against the
Cloudflare token API, and materialized only as a root-owned mode `0600` runtime
file. The legacy file remains until the corrected private-ingress Traefik
revision is approved and deployed.

## Local macOS evidence

- Shell startup blocks and removes inherited `OP_SERVICE_ACCOUNT_TOKEN` and
  `INFISICAL_TOKEN`; no secret file is sourced.
- `withsecrets` uses the signed-in human session and injects the seven Local
  Development names only into its child process.
- The Onshape MCP starts directly through `infisical run`; a real initialize
  handshake passed.
- Three obsolete local 1Password development files and 63 shell snapshots that
  contained the retired token assignment were deleted after verification.
- The retired Go `os-connector` process, LaunchAgent, binary, local configuration,
  registration token, and logs were removed. Current development uses the
  Environment and Workspace Runtime path; no replacement Connector credential
  was created or migrated.
- Personal vault contents, the 1Password app and SSH agent, and personal SSH
  keys were not changed.
- The already-running Codex desktop process may retain its inherited environment
  until it is restarted; new shells are clean.

## Other repository findings

The machine-wide scan excluded dependency/build output and historical Codex
session transcripts. These current shared checkouts still contain active or
documented 1Password development contracts and require their own issues and
managed worktrees:

| Repository or directory | Evidence | Ownership/action |
| --- | --- | --- |
| `DotNaos/private-vps-platform` | 14 tracked files plus untracked provider/local-admin work use `op read`, `op inject`, or `op://` | Issue `DotNaos/private-vps-platform#1`; blocked until the large dirty checkout is handed to its owning branch, because the active files do not all exist on `origin/main` |
| `DotNaos/project-template` | Approved PR #17 head `8b2aed5a590a1682b7d2382ce7cad6fa63f9c390` was squash-merged as `99cc212e9871a178f05fc3dda715a8afebe4e104`; fresh local generation, real Infisical injection, and the exact `main` revision's generated-project and container jobs passed | Repository `OP_SERVICE_ACCOUNT_TOKEN` remains absent |
| `DotNaos/inventory` | Approved PR #4 head `6d5dbe2e5767a888e43ecec9630b5b10eabfc1ed` was squash-merged as `dcc7586b245d47a61130536ddf5c19d16f0c42f8`; real Infisical injection, template validation, checks, build, Compose, and the exact `main` revision's check and container jobs passed | Repository `OP_SERVICE_ACCOUNT_TOKEN` remains absent; the protected Infisical contract job remains opt-in and was skipped on the ordinary `main` push |
| `projects/print-lab` | The unversioned generated directory now uses the same names-only Infisical contract locally; real injection, 112 geometry tests, remaining checks, build, and Compose passed | No GitHub repository or repository secret exists; existing unrelated template-adherence violations remain outside this migration |
| `projects.school/FS26/crosswalk-detector` | One remote-run script resolves `HF_TOKEN` with `op read` | Separate school-project migration |
| `projects.school/tools/fhgr-server-config` | SSH wrappers and docs use `op run` with `SSHPASS` | Separate school-tool migration; credential ownership is `Private`, not Project Space |
| `DotNaos/ui` | One documentation example uses `op read` for a signing key | Documentation-only follow-up; no runtime consumer found |

Stale Codex worktrees and the read-only shared Project Space main checkout still
reflect their own revisions. They are not edited by this issue and must not be
used as evidence that the review branch failed to remove an active path.

## Delivery gates

- GitHub loads a `workflow_run` deployment workflow from the default branch.
  While `main` still contains the 1Password implementation, a green PR build
  cannot execute PR #755's own credential steps. PR #770 therefore added a
  trusted, manually dispatched, non-deploying OIDC smoke workflow on `main` so
  the three fixed identities can be proven without exposing credentials to
  pull-request code. Run 31894189550 passed all three boundaries at exact commit
  `5a5f6f730b584c110cc88cdd0332bef12c82fd23`.
- Do not merge this issue's pull request or deploy Production until the current
  exact revision is approved and the OIDC-backed Preview, Production, and signer
  jobs pass.
- Do not merge or deploy PR #735 or issue #731 as evidence for this migration.
- Provision the VPS identity authentication only through a separate, explicit,
  attributable operator action. Never create it from CI, bootstrap, or runtime
  code.
- After a later approved deployment, verify the exact running commit, service
  health, application health endpoint, reachable origin, and rollback record.
