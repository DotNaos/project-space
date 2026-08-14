# Infisical secret delivery inventory

This inventory records secret consumers and ownership boundaries without secret
values. It is evidence for issue #754 and must be updated when a consumer or
identity changes.

## Project Space boundaries

| Consumer | Infisical project and environment | Authentication | Delivery | Status |
| --- | --- | --- | --- | --- |
| Local Project CLI development | `project-space` / `dev` | Signed-in human CLI session in the macOS Keychain | `infisical run` from the checked-in `infisical://` reference | Implemented and locally tested |
| GitHub Preview deploy and reaper | `project-space-preview` / `staging` | Fixed identity `5eaeaafe-2b13-4ca2-9506-4c914924e5b6`; GitHub OIDC subject `repo:DotNaos/project-space:environment:Preview`; 15-minute token | Pinned `Infisical/secrets-action` exports job-only environment variables | Implemented; CI proof required before activation |
| GitHub Production deploy | `project-space-production` / `prod` | Fixed identity `454fcc36-3e86-4c9f-b25d-e581d342bc36`; GitHub OIDC subject `repo:DotNaos/project-space:environment:Production`; 15-minute token | Pinned action exports job-only environment variables | Implemented; no deployment before exact-revision approval |
| Release-manifest signer | `project-space-release-signing` / `prod` | Fixed identity `577f6b4c-943b-4bf5-94ac-07140f1e5b2d`; GitHub OIDC subject `repo:DotNaos/project-space:environment:release-signing`; 15-minute token | Pinned action in the isolated no-checkout signer job | Implemented; CI proof required before release |
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
| `project-space-production` | `prod` | 12 names: deploy SSH/Tailscale, Clerk, GitHub OAuth/token, release public key, rate-limit, MQTT provider, and Vite Clerk |
| `project-space-release-signing` | `prod` | `PROJECT_RELEASE_MANIFEST_SIGNING_PRIVATE_KEY_B64` |
| `project-space-vps` | `prod` | 15 names: application runtime, machine-power MQTT, and JetKVM SSH/Tailscale provisioning |
| `local-development` | `dev` | 7 names: Gemini, Google, Moodle, study calendar, and Onshape MCP credentials |

Each migrated secret has a 90-day review reminder. Secret values are not stored
in repository files, workflow inputs, command arguments, shell snapshots, or
this inventory.

## Local macOS evidence

- Shell startup blocks and removes inherited `OP_SERVICE_ACCOUNT_TOKEN` and
  `INFISICAL_TOKEN`; no secret file is sourced.
- `withsecrets` uses the signed-in human session and injects the seven Local
  Development names only into its child process.
- The Onshape MCP starts directly through `infisical run`; a real initialize
  handshake passed.
- Three obsolete local 1Password development files and 63 shell snapshots that
  contained the retired token assignment were deleted after verification.
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
| `DotNaos/project-template` | Template secret runner, CI workflow, examples, and nine files use the 1Password contract | Separate template migration required before generated projects are updated |
| `DotNaos/inventory` | Generated template copy and project CI use the same contract | Update from the migrated template in its own issue/worktree |
| `projects/print-lab` | Unversioned generated directory contains the same template contract | No repository owner is present; do not mutate or delete without an explicit ownership decision |
| `projects.school/FS26/crosswalk-detector` | One remote-run script resolves `HF_TOKEN` with `op read` | Separate school-project migration |
| `projects.school/tools/fhgr-server-config` | SSH wrappers and docs use `op run` with `SSHPASS` | Separate school-tool migration; credential ownership is `Private`, not Project Space |
| `DotNaos/ui` | One documentation example uses `op read` for a signing key | Documentation-only follow-up; no runtime consumer found |

Stale Codex worktrees and the read-only shared Project Space main checkout still
reflect their own revisions. They are not edited by this issue and must not be
used as evidence that the review branch failed to remove an active path.

## Delivery gates

- Do not merge this issue's pull request or deploy Production until the current
  exact revision is approved and the OIDC-backed Preview, Production, and signer
  jobs pass.
- Do not merge or deploy PR #735 or issue #731 as evidence for this migration.
- Provision the VPS identity authentication only through a separate, explicit,
  attributable operator action. Never create it from CI, bootstrap, or runtime
  code.
- After a later approved deployment, verify the exact running commit, service
  health, application health endpoint, reachable origin, and rollback record.
