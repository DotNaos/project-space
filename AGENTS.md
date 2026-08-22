## Checkout role routing

After claiming an agent name, every agent MUST run
`project worktree context --format json` before any repository action. When the
result is `state=main`, invoke the versioned
`plugins/project-space/skills/project-manager/SKILL.md` workflow and keep the
shared checkout read-only. When the result is `state=owned`, use the returned
Project-managed issue worktree for implementation. `state=foreign` and
`state=unmanaged` are observer-only and must not mutate, install, generate,
build, commit, or deploy. Missing, invalid, ambiguous, or failed context is
fail-closed: stop mutation and obtain a proven Project-managed context.

## Parallel Codex Work

- Before changing the repository, list the active Codex tasks and inspect every active task working in this repository. Identify its branch, worktree, owner thread, and likely file ownership before choosing where to work. The agent must perform this check itself instead of waiting for the user to mention parallel work.
- Never implement changes in the shared `main` worktree. It is read-only orientation and bootstrap space only: do not edit files, run generators or builds, create commits, or use it as an integration area.
- Every implementation mutation requires a GitHub issue, a dedicated branch,
  and a Project-managed issue worktree under
  `~/projects/.worktrees/{project}/{branch}`. Issue-less claims are
  observer-only and fail closed for mutation.
- Before editing, the main Project Manager task runs the context gate from the
  shared main checkout and remains read-only there. It does not run local
  `project worktree check` or `project worktree prepare`; the canonical Codex
  start operation owns preparation and returns the implementer task.
- The main Project Manager task remains in the shared main checkout after the
  context gate and never mutates or claims an implementation worktree. It
  dispatches through the canonical
  `project codex start --issue <number> --environment-id <id> --operation-id <id> --format json`
  operation. That operation prepares the issue-bound Project-managed worktree
  and returns the implementer task; only that implementer task owns and uses
  the returned worktree. The same Codex chat may reuse its Manager surface for
  related changes without creating additional issues. Subagents work under an
  established implementer claim and must not prepare or check the worktree
  using their distinct subagent thread IDs. A different main Codex chat must
  use a different worktree and must never overwrite the existing owner.
- Before `project codex start` can dispatch, the local Manager caller gate must
  prove `state=main`, `role=project-manager`, `mutatingAllowed=false`, and the
  same current `CODEX_THREAD_ID` as the initiating/reporting task. Owned,
  foreign, unmanaged, missing or invalid context, and caller-supplied role or
  thread alternatives fail closed before network dispatch; remote task metadata
  remains caller-supplied evidence until the Manager workflow verifies it.
- If `CODEX_THREAD_ID` is unavailable, do not mutate the repository. Continue the work in a Codex chat that has a thread ID, then prepare its worktree.
- If the current worktree is dirty, belongs to another task, or contains changes whose ownership is unclear, leave those changes untouched and prepare a fresh worktree based on the latest `origin/main`. Do not solve the collision by stashing, committing, resetting, or moving another task's files.
- Integrate completed work through its dedicated branch and pull request. Reconcile with the latest `main` inside that task's worktree before merging, rather than using the shared worktree as an integration area.

## CI preflight and coherent pull request revisions

- Treat every push that creates or updates a pull request as a handoff to CI. Commit the exact revision locally, then run the fast changed-path preflight with `bun run ci:preflight --base origin/main --head HEAD --pull-request <number> --format json` before pushing it.
- Use `bun run ci:preflight:full --base origin/main --head HEAD --pull-request <number> --format json` when comprehensive local proof is useful. It runs all locally reproducible Fast CI lanes, the release-quality TypeScript check, and macOS packaging when available; protected and foreign-platform gates remain remote-only.
- Both preflight reports record the requested local profile, exact base and head commits, changed paths, GitHub release-policy selection, every local result, and every protected remote-only gate. A green local report is not signing, release, Preview, deployment, rollback, or health proof.
- Every pull request that changes the product must add exactly one immutable Markdown file at `changelog/<PR-number>.md`. The filename is the pull request number, not the issue number and not a generated UUID.
- The changelog `bump` is required and must be `patch`, `minor`, or `major`; there is no `none`. Every merged pull request receives a concrete version, while `package.json` remains unchanged and the serial release queue assigns the next version after merge.
- The raw changelog is the source record shown in the Docs Unreleased Inbox until the release queue associates it with a published version. Do not edit another pull request's changelog or historical files under `apps/docs/content/docs/releases/entries/`.
- New pull requests must not add release-intent files. The one-time rollout PR may carry one matching legacy release-intent file solely for migration compatibility.
- Pull requests never assign a concrete version, change `package.json` version, or edit historical versioned release entries. The serial queue derives the next version from the latest published signed release only after merge, reserves that exact tag, and processes release-bearing merges oldest first.
- GitHub-generated release notes summarize the merged changes included in each published release. Files under `apps/docs/content/docs/releases/entries/` are immutable history from the former authoring flow.
- If CI fails, inspect all failures, reproduce the shared cause locally where possible, repair the complete revision, rerun the canonical preflight, and push once. Do not blind-retry deterministic failures.
- Drafts keep all non-release checks. A ready exact head remains unmergeable when its trusted release decision is invalid, whether it is an ordinary pull request or an explicit release pull request.
- Use `bun run ci:inventory:open-prs --format markdown` for a read-only legacy report. It never edits, readies, closes, or replaces checks on another pull request.

## Project Space Deployments

- Do not deploy Project Space to Vercel. Vercel is not the production target for this app.
- Production deploys for Project Space go to the VPS through the Project CLI: `./bin/project deploy --env prod`.
- After an authorized merge, let every repository-configured workflow triggered by that merge run normally, including automatic production deployments. Do not cancel, disable, pause, or otherwise interfere with that automation unless the user explicitly asks you to stop or cancel it.
- A merge instruction does not by itself authorize starting a separate manual deployment or release, but it must never be used as a reason to cancel deployment or release automation that the repository starts automatically after the merge.
- The live Project Space URL is `https://projects.os-home.net`.
- After deploying, verify the VPS state with `./bin/project deploy status --env prod --format json`, confirm the remote checkout commit under `/opt/platform/apps/project-space`, and open the live `projects.os-home.net` page in the browser.
- If deployment secrets are needed, use the Infisical references in `deploy/deploy.yaml`; never paste secret values into chat, source files, or logs. Fixed workload identities must be provisioned explicitly and must never be created by a workflow.
- Do not treat a successful Vercel preview or production deployment as evidence that Project Space is live. Only the VPS deploy and `projects.os-home.net` verification count.

## Managed development servers

- Agents MUST start Project Space development servers with plain `project serve`,
  which publishes a managed review route by default. Do not pass `--no-tailnet`
  or its deprecated `--local-only` alias unless the user explicitly requests a
  machine-local server in the current task. Do not infer that opt-out from
  convenience, debugging, browser availability, or a desire to reduce setup.
- The Project CLI owns the complete development-server lifecycle, including
  Portless routing, review-route reservation, secret injection, heartbeat,
  status, and cleanup.
  Do not replace a failed CLI operation with manual `tmux`, `tailscale serve`,
  `portless`, `infisical run`, or direct Vite startup. Fix the Project CLI and
  exercise its development build until that fix is released, then run the same
  operation through the CLI again.
- After starting or reusing a managed development server, run
  `project serve status <directory> --script <script> --json` and require
  `state=running` plus a non-empty `publicUrl`. Report the exact review URL
  returned by that status to the user; never reconstruct or guess it.
- Managed review names use
  `<project-slug>-<task-id>.review.vpn.os-home.net`. The Project CLI consumes
  the authenticated server-owned review-route API to reserve, register, renew,
  and delete each explicit name. The VPS terminates TLS and reverse-proxies only
  HTTP/HTTPS to a validated direct Tailscale IPv4 address in `100.64.0.0/10`.
  Do not implement Cloudflare credentials, ACME, Traefik file mutations,
  `.ts.net` names, MagicDNS, SSH tunnels, or a second proxy in Project Space.
- When the user asks to open or show the development server, open the managed
  `publicUrl`, including the requested page path, rather than the local
  Portless URL. The local URL remains a diagnostic surface, not the default
  handoff URL.
- Managed publication is fail-closed. If the route API is unavailable, a name
  collides, the lease expires, or the default start cannot publish, diagnose and
  report the failure instead of inventing a hostname or silently retrying with
  raw `100.x` HTTP, `.ts.net`, MagicDNS, or `--no-tailnet`. When the user
  explicitly requests local-only mode, state that
  no managed review URL exists and report the verified local URL instead.

## UI component policy

- New UI work uses [`@dotnaos/ui`](https://www.npmjs.com/package/@dotnaos/ui) as the primary component library. Its source and documentation live in [`DotNaos/ui`](https://github.com/DotNaos/ui).
- Use `@dotnaos/ui-base` for generic foundations and controls, and `@dotnaos/design` for shared tokens and styles. Follow the current package boundaries and slash-based feature subpaths documented in `DotNaos/ui`.
- Do not introduce new HeroUI components. Existing HeroUI code may be touched only for narrowly scoped legacy maintenance or an explicit migration.
- React Native work uses the native implementation exposed by `@dotnaos/ui`, not HeroUI Native.
- When Project Space needs a missing component that is generic enough for multiple projects, immediately create a focused issue in [`DotNaos/ui`](https://github.com/DotNaos/ui/issues) that links to the exact Project Space path and first implementation.
- Do not block Project Space on that extraction. Implement the component locally behind one small, project-neutral module boundary; keep Project Space data fetching, domain state, permissions, and business behavior outside it; use portable dependencies and DotNaos design tokens; expose an API suitable for `@dotnaos/ui`; and route all call sites through one local import. Promotion should require moving the component and changing imports, not redesigning its public contract.
