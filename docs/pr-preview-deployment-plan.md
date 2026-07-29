# PR preview deployments plan

Issue: [#263 PR Preview Deployment](https://github.com/DotNaos/project-space/issues/263)

Status: approved on 2026-07-22 and implemented in the dedicated Issue #263 worktree. External infrastructure activation and live VPS verification remain separately approval-gated.

## 1. Problem abstraction

An agent can create a pull request, but the user cannot open that exact PR build on a stable hosted URL before merge. Iteration therefore depends on local development or merging into `main`, even though production must remain reserved for verified `main` commits.

The feature needs four connected capabilities:

1. automatic trusted lifecycle handling, with Project CLI recovery for one open PR;
2. a trusted build and VPS runtime path isolated from Production and Beta;
3. a read-only preview inventory that proves what is actually running;
4. deterministic cleanup when the PR closes or merges.

## 2. Bad state

The bad state is not merely “the preview link is missing.” The structurally invalid states are:

- PR code runs the production deployment CLI, Compose files, Dockerfile, or secret set;
- a URL is shown because its name looks like `pr-263`, although the runtime was not verified;
- a preview SHA is mixed into the durable environment model and is presented as a real deployed release;
- a merged or closed PR still exposes an apparently current preview link;
- cleanup is considered successful merely because a registry row disappeared;
- a stale PR head is deployed after a force-push or concurrent update;
- one PR can name arbitrary VPS paths, Compose projects, domains, or secrets;
- PR-controlled code can read the shared Clerk secret, raw GitHub OAuth tokens, or the global GitHub fallback token merely because Preview reuses the existing Clerk and GitHub integrations.

## 3. Why the current approach cannot be extended directly

The existing production deploy path is deliberately strict and should stay so:

- `deploy/deploy.yaml` defines exactly `prod` and `beta`;
- Production accepts only `main` and uses a shared lock, exact-SHA verification, live health evidence, and rollback;
- the production workflow receives powerful application and connector secrets;
- the checked-out commit supplies `deploy/compose.yml`, `deploy/Dockerfile`, and `.dockerignore`;
- the current read-only environment model treats every healthy matching environment as an actual deployed release.

Adding `preview-263` as another normal `--env` value would weaken those contracts. In particular, an unmerged PR could change its own deployment files, mounts, labels, build context, or runtime code and then receive Production credentials.

The existing Private Platform adapter is also not the current answer. It can create dynamic deployments, but the repository has no complete delete contract, no proven PR isolation, and its hosted mutation path is intentionally blocked.

## 4. Recommended architecture

### 4.1 Control path

Opening, reopening, or synchronizing a same-repository PR against `main` is the
standard control path. Trusted `pull_request_target` workflow code resolves the
event's full head SHA through the GitHub API and requires the API result to still
match the event before continuing. A stale event fails closed so that its newer
lifecycle event owns the update.

The manual recovery command is:

```sh
project deploy preview --pr 263 --format json
```

The installed, signed Project CLI must be used. A PR-local `./bin/project` is not a trusted control plane.

The command:

1. resolves the repository from `origin`;
2. resolves PR #263 through GitHub;
3. requires an open, same-repository PR targeting `main`;
4. records the full current head SHA;
5. dispatches `.github/workflows/deploy-preview.yml` from trusted `main`, never from the PR branch;
6. passes only the numeric PR number and a random operation ID;
7. optionally waits for the correlated workflow result and prints the verified URL.

Supporting commands:

```sh
project deploy preview status --pr 263 --format json
project deploy preview status --all --format json
project deploy preview destroy --pr 263 --format json
```

`destroy` is the manual recovery path. The normal lifecycle cleanup remains automatic.

### 4.2 Trusted build boundary

The preview workflow is owned by `main` and uses pinned actions. Automatic
lifecycle events and manual recovery share the same exact-SHA gates. It separates
untrusted code execution from infrastructure credentials:

1. resolve and revalidate the current PR head;
2. fetch the exact PR head anonymously from the fixed public repository URL;
3. run the normal validation suite with no job token, environment, Preview, or Production secrets;
4. build images using a trusted Dockerfile/build recipe sourced from `main`, not from the PR;
5. publish immutable images identified by digest;
6. pass only PR number, repository, exact SHA, and image digests to the Preview deploy job.

The deploy job never executes scripts or configuration from the PR checkout. It talks to a narrow Preview runner on the VPS.

### 4.3 VPS preview runner

The Preview runner is separate from the general Production deploy shell. It accepts a structured, validated request and derives every resource name from repository plus positive integer PR number.

For Project Space PR #263:

```text
preview id       project-space-pr-263
web URL          https://pr-263.projects.os-home.net
API origin       https://pr-263.projects.os-home.net/api
runtime root     /opt/platform/previews/project-space/pr-263
compose project  project-space-preview-pr-263
lock             /opt/platform/locks/project-space-preview-pr-263.lock
runtime state    /opt/platform/state/project-space-preview/pr-263/runtime.json
tombstone        /opt/platform/state/project-space-preview/pr-263/tombstone.json
database volume  project-space-preview-pr-263_postgres-data
```

The hostname is always `pr-{positive PR number}.{project domain}.os-home.net`. It is derived by trusted policy and never accepted from the PR or CLI input. Browser and API use the same origin. For Project Space, whose project domain is `projects.os-home.net`, PR #263 therefore always maps to `pr-263.projects.os-home.net`.

The runner uses a trusted Compose/ingress template and enforces:

- no Docker socket or SSH mounts in PR containers;
- no Production state mounts;
- a dedicated database volume per PR;
- an isolated internal network;
- a trusted ingress/proxy component as the only attachment to `traefik-public`;
- CPU, memory, PID, log-size, and lifetime limits;
- immutable repository, PR, and SHA labels on every resource;
- no arbitrary path, domain, Compose name, image, or shell input.

### 4.4 Secret boundary

Create a separate GitHub Actions `Preview` environment, Preview-only 1Password service account, SSH identity, and Tailscale tag. This is an infrastructure permission boundary, not a second GitHub product integration. Never reuse the GitHub Actions `Production` environment.

PR runtime code must never receive:

- the shared Clerk secret key;
- raw GitHub OAuth access tokens or the global GitHub fallback token;
- connector registration credentials;
- connector command-signing keys;
- release-signing keys;
- machine rate-limit secrets;
- Production database or state access;
- a general VPS shell or Docker API.

Preview deliberately reuses the existing Clerk instance, users, and browser session model. It also deliberately reuses the existing GitHub OAuth application and the user's existing GitHub connection. No second Clerk instance, GitHub OAuth app, or test-only identity is introduced.

Because the PR application image is untrusted, reuse is provided through a trusted auth/integration gateway built from `main`, not by copying shared credentials into the PR containers. The gateway:

- is the only public ingress and strips any caller-supplied identity headers;
- validates Clerk tokens against the existing instance and the exact Preview origin, including `authorizedParties`/origin binding for `https://pr-{id}.projects.os-home.net`;
- forwards only a short-lived, PR- and SHA-bound identity assertion to the Preview backend;
- brokers the existing user-scoped GitHub connection through bounded Project Space operations and never returns the raw OAuth token;
- keeps its credential and token state outside the PR database, images, environment, and mounts;
- denies connector, machine-control, signing, release, deployment, and arbitrary GitHub proxy operations.

The shared provider instances are therefore a deliberate product choice, while the raw credentials remain part of the trusted control plane. If the gateway cannot prove the exact Clerk origin or the current user-scoped GitHub authorization, the Preview fails closed instead of silently using a global token.

### 4.5 Runtime truth and GitHub reporting

The VPS registry is the operational source of truth. GitHub Deployments is a secondary provenance mirror.

After full verification, the workflow creates or updates a transient GitHub Deployment status with the exact SHA and `environment_url`. On cleanup it marks the deployment inactive. GitHub reporting failure must not fabricate or erase VPS evidence.

The registry is written atomically and retains a small tombstone after cleanup so the UI can distinguish confirmed removal from missing or unavailable data.

## 5. State machine

```text
                         head changed / PR invalid
Absent -> Queued -> Validating --------------------> Rejected or Superseded
              |          |
              |          v
              |       Building --------------------> FailedInitial
              |          |
              |          v
              |       WaitingForPRLock ------------> Blocked
              |          |
              |          v
              |       Deploying
              |          |
              |          v
              |       Verifying -------------------> FailedInitial
              |          |
              |          v
              +-------> Ready(current SHA)

Ready(old SHA) -> Queued -> ... -> Ready(new SHA)
                                  |
                                  +-------------> UpdateFailed
                                                   old verified preview remains

Ready / UpdateFailed -> CleanupQueued -> Deleting -> Removed
                                             |
                                             +----> CleanupFailed -> Reaper retry
```

Close and deploy use the same PR-specific GitHub concurrency key and the same VPS lock. The VPS rechecks PR state and head SHA under that lock, so workflow ordering alone is never treated as truth.

## 6. Evidence objects

### Repository evidence

```text
RepositoryEvidence(fullName, defaultBranch, checkedAt)
```

Created only after the Git remote and GitHub repository agree.

### PR evidence

```text
PullRequestEvidence(
  repository,
  number,
  state,
  baseRef,
  headRef,
  headSha,
  isCrossRepository,
  checkedAt
)
```

`headSha` is a full 40-character SHA. `GitHubPullRequestRecord` must gain this field in both GraphQL loading and create-PR responses.

### Build evidence

```text
PreviewBuildEvidence(repository, prNumber, headSha, webImageDigest, docsImageDigest)
```

The digests are produced by the trusted workflow after the untrusted build stage. Tags alone are not evidence.

### Runtime evidence

```text
PreviewRuntimeEvidence(
  repository,
  prNumber,
  requestedSha,
  runningSha,
  webImageDigest,
  docsImageDigest,
  composeHealthy,
  httpHealthy,
  liveOriginHealthy,
  metaSha,
  liveUrl,
  verifiedAt
)
```

### Cleanup evidence

```text
PreviewCleanupEvidence(
  containersAbsent,
  networksAbsent,
  volumesAbsent,
  runtimePathAbsent,
  routeAbsent,
  removedAt
)
```

The tombstone contains only sanitized identity, timestamps, and this positive absence evidence.

## 7. Preconditions and gates

### CLI dispatch gate

```text
PreviewDispatchAllowed
=> installed trusted CLI
AND repository proven
AND PR proven open
AND PR base == main
AND PR belongs to same repository
AND caller has repository write permission
AND requested SHA == current PR head SHA
```

### VPS mutation gate

```text
PreviewMutationAllowed
=> trusted workflow identity
AND Preview environment credentials
AND immutable image digests
AND PR-specific lock held
AND PR still open under lock
AND requested SHA still equals current PR head
AND resource quota and minimum free space satisfied
```

### Shared auth and GitHub integration gate

```text
PreviewRequestAuthorized
=> trusted gateway image from main
AND request host == derived pr-{id}.{project domain}.os-home.net
AND Clerk issuer belongs to the existing configured instance
AND Clerk authorized party == exact Preview origin
AND gateway assertion audience == repository + PR + requested SHA
AND GitHub operations use the current user's existing OAuth connection
AND no raw Clerk or GitHub credential reaches PR-controlled code or storage
```

### Preview link gate

```text
CurrentPreviewLinkVisible
=> PR is open
AND registry repository and PR match
AND registry requested SHA == current PR head SHA
AND running SHA == metadata SHA
AND runtime image digests == requested image digests
AND Compose, HTTP, and live-origin checks are healthy
AND URL passed public-HTTPS sanitization
```

### Cleanup gate

```text
PreviewRemoved
=> PR is closed or merged
AND PR-specific lock held
AND all named resources are absent
AND tombstone persisted
AND GitHub deployment marked inactive when reporting is available
```

## 8. Earliest allowed display

The UI can show `Checking preview…` once repository and PR identity are known.

Before successful inventory evidence, it may show only:

- `Not deployed` from a successful, exact-PR empty result;
- `Unavailable` or `Unauthorized` from an explicit failure;
- a last safe preview clearly marked stale, but only for the same repository and PR.

It must not derive existence, currentness, or URL from the PR number, branch name, workflow name, cache entry, or hostname convention.

## 9. Renderer and UI rules

Preview data gets a separate `PullRequestPreviewStatusResult`. It must not be appended to `DeployedEnvironmentStatusResult.environments`, because current topology and workflow correlation interpret any healthy matching environment as an actual deployed release.

### Issue detail

The existing Development session becomes:

1. Branch
2. Pull request
3. Preview deployment
4. Start development
5. Run tests

Behavior:

- no PR: keep `Create PR`;
- open PR, no preview: show PR identity and `Not deployed`;
- queued/building/deploying: show honest progress without a current link;
- ready at current head: show `Open preview`, short SHA, and verification time;
- previous healthy SHA after a failed update: show `Last working preview`, explicitly outdated;
- closed/merged PR: hide the current link immediately and show cleanup state;
- removed: show confirmed cleanup from tombstone;
- unavailable: do not turn it into `Not deployed`.

The issue workbench must receive the repository PR list. The current action panel already exceeds the 500-line soft limit, so implementation first extracts a focused Development-session component plus new preview status/model/hook files.

### Deployments page

Add a distinct `Pull request previews` section below durable environments. Do not mix previews into Production/Beta rows or topology delivery state. Show active previews first, then cleanup failures/tombstones as bounded recent history.

### Mobile at 390 px

The Issue detail uses one document scroll area on narrow screens. Hide the left Issue list, then show Issue content and Development session in order. Avoid nested mobile scroll containers; make the Preview link full-width with safely truncated host text and preserve space above bottom navigation.

## 10. UI invariants

```text
ProductionDeployedClaim
=> durable environment evidence
=> never PR preview evidence

CurrentPreviewClaim(pr, sha)
=> open PR evidence for sha
AND verified Preview runtime evidence for sha

OutdatedPreviewClaim(pr, oldSha)
=> open PR evidence for a different current sha
AND last verified Preview runtime evidence for oldSha

NotDeployedClaim(pr)
=> successful exact-PR inventory result with no active or stale record

RemovedClaim(pr)
=> positive cleanup evidence in a tombstone

LinkVisible
=> sanitized public HTTPS URL
AND one of CurrentPreviewClaim or explicitly labelled OutdatedPreviewClaim
```

## 11. Proof sketch

The browser receives preview data only through the authenticated, repository-scoped Preview endpoint. The server strips VPS paths, Compose names, hosts, stderr, secret sources, and non-public URLs. The UI joins that record with the GitHub PR by repository plus PR number and compares full SHAs.

Therefore a current link can exist only after:

1. GitHub proves the PR is open at a specific SHA;
2. the trusted workflow and VPS registry identify the same repository, PR, and SHA;
3. runtime checkout, image, metadata, health, and live-origin evidence agree;
4. the server sanitizes the public URL;
5. the UI currentness gate passes.

Preview records are kept outside the durable environment array, so a healthy PR SHA cannot advance Production or topology delivery state.

## 12. Allowed error cases

- GitHub authentication missing or repository unauthorized;
- PR missing, closed, merged, forked, or targeting another base;
- current PR head changes before or under the lock (`superseded`);
- validation or build failure before VPS mutation;
- quota, disk, lock, DNS, TLS, or Preview runner unavailable;
- initial deployment failure with full partial-resource cleanup;
- update failure while the prior verified Preview remains available as outdated;
- cleanup failure with visible retryable state and Reaper recovery;
- GitHub deployment reporting unavailable while VPS evidence remains intact;
- stale last-safe data after a refresh failure, limited to the same repository/PR identity.

## 13. Disallowed error cases

- executing PR-controlled source in a `pull_request_target` job that has a
  checkout token, Preview credentials, write-capable permissions, deployment
  control inputs, or a protected environment;
- running PR deployment files or a PR-local Project CLI with Preview credentials;
- passing any Production secret or mount to PR containers;
- treating branch, tag, workflow success, GitHub Deployment success, or URL shape as runtime proof;
- showing a closed/merged PR as current while cleanup is pending;
- deleting paths or Docker resources not derived from and labelled for the exact PR;
- running broad `docker system prune` during cleanup;
- sharing a database volume between Production and a Preview;
- letting Preview concurrency or locks block Production deployment;
- deploying through Vercel.

## 14. Consequences for code, tests, and documentation

### Implementation slices

1. **Trusted Preview contract and CLI dispatch**
   - add `project deploy preview` commands in focused Go files;
   - resolve PR identity, head SHA, caller permission, operation ID, workflow dispatch, wait, and JSON output;
   - keep existing `project deploy --env prod|beta` behavior unchanged;
   - regenerate CLI docs and add drift tests.

2. **Preview workflow and runner contract**
   - add pinned `deploy-preview.yml` with distinct validation, untrusted build, publish, and trusted deploy jobs;
   - add a separate `Preview` GitHub environment and least-privileged credentials;
   - add trusted build/Compose assets outside PR control;
   - implement exact-SHA deployment, first-deploy cleanup, update rollback, registry writes, and resource limits.

3. **Automatic lifecycle and Reaper**
   - use trusted `pull_request_target` events to resolve same-repository PR heads
     on open, reopen, and synchronize, rejecting stale event heads;
   - execute PR validation only in a separate credential-free job, then build
     with trusted recipes and deploy immutable digests;
   - use `pull_request_target: closed` for trusted cleanup without PR checkout;
   - serialize close/update on the same PR lane and VPS lock;
   - add a scheduled and manual Reaper for closed PRs, expired previews, and cleanup failures;
   - mark GitHub Deployment status inactive after positive cleanup evidence.

4. **Separate Preview API**
   - add `GET /api/pull-request-previews/status?repositoryFullName=...&pullRequestNumber=...`;
   - require normal project authorization and `Cache-Control: private, no-store`;
   - sanitize registry output and distinguish available, unauthorized, unavailable, and confirmed empty;
   - extend `GitHubPullRequestRecord` with full `headSha` in GraphQL and create-PR results.

5. **Trusted shared-auth and GitHub gateway**
   - reuse the current Clerk instance and GitHub OAuth application without exposing their secrets to the PR image;
   - bind Clerk verification and internal identity assertions to the exact Preview origin, repository, PR, and SHA;
   - broker only the existing Project Space GitHub operations for the signed-in user and reject raw-token or arbitrary-proxy access;
   - keep gateway credential/token state separate from the PR database and prove forged identity headers fail closed.

6. **Issue and Deployments UI**
   - pass linked PRs into the Issue workbench;
   - extract the Development-session component before adding Preview UI;
   - add current/outdated/failed/cleanup states and safe links;
   - add a separate Pull request previews section on Deployments;
   - fix the narrow Issue-detail scroll contract and verify at 390 px.

7. **Infrastructure bootstrap**
   - add and verify Tailnet DNS routing for `*.projects.os-home.net`, while admitting only derived `pr-{positive integer}.projects.os-home.net` hosts at ingress;
   - provision trusted wildcard TLS for `*.projects.os-home.net` or an equivalently bounded certificate strategy;
   - configure the existing Clerk instance for the exact Preview origins and create only the separate GitHub Actions environment, 1Password service account/items, SSH forced command/controller, and Tailscale ACL/tag;
   - define a small maximum active count, global build concurrency, minimum free space, and TTL.

8. **Verification and dogfooding**
   - deploy a real test PR and prove `/api/app/meta`, health, public page, exact SHA, and UI link;
   - update the PR and prove the same URL moves only after verification;
   - run two simultaneous Previews and prove network/database/resource isolation;
   - fail an update and prove the old verified Preview remains explicitly outdated;
   - close during deploy and prove convergence to removed;
   - prove containers, networks, volumes, paths, routes, registry state, and GitHub status are cleaned;
   - verify Production SHA and all Production health evidence remain unchanged;
   - browser-dogfood desktop and 390 px through ready, outdated, failure, cleanup, and refresh-error states.

### Automated test groups

- Go CLI: PR parsing, permission, fork/base/state rejection, full SHA, dispatch correlation, wait behavior, redacted JSON.
- Workflow contract: trusted `main` dispatch, pinned actions, least permissions, no Production environment/secrets, no Vercel, no PR checkout in cleanup.
- Runner transaction: deterministic resources, injection rejection, lock races, force-push supersession, first-deploy failure cleanup, update rollback, idempotent destroy, positive absence evidence.
- Security: PR Dockerfile/Compose/.dockerignore ignored; no Preview secrets in build context; no Production secrets/mounts; only immutable image digests accepted; forged identity headers, wrong Clerk origins, raw-token access, and arbitrary GitHub proxy calls rejected.
- Server/API: auth, repository scoping, full-SHA matching, URL sanitization, private/no-store caching, tombstones, stale last-safe identity.
- UI: no PR, not deployed, queued, ready, outdated, failed, cleanup pending/failed, removed, unavailable, stale; only properly gated links render.
- Regression: Preview never marks topology or durable deployment state as deployed; Production/Beta status and workflow correlation remain unchanged.

### Documentation

- explain automatic lifecycle deployment plus CLI recovery and machine-readable results;
- document the trust boundary and why PR-local deploy assets are ignored;
- document Preview identity, limits, TTL, cleanup, Reaper, and manual destroy;
- document external DNS/TLS, exact Clerk origin binding, the reused GitHub OAuth application, trusted gateway, Tailscale, SSH, 1Password, and GitHub Actions environment setup;
- document exact recovery steps without exposing secret values.

## Finishing criteria

Implementation is complete only when all of the following are true:

- one CLI command deploys the current open PR through trusted `main` workflow code;
- the URL is shown in Issue detail and in a separate Deployments preview section;
- only a fully verified current SHA receives the current Preview label;
- failed updates preserve but clearly demote the last verified Preview;
- merge and close both trigger cleanup, and the Reaper repairs missed cleanup;
- Preview code has no raw shared Clerk/GitHub credentials, Production data, mounts, runner, lock, or Compose project;
- the existing Clerk instance, user identity, and GitHub OAuth integration work through the trusted gateway at `pr-{id}.{project domain}.os-home.net`;
- cleanup proves absence of every PR resource and retains a bounded tombstone;
- Production remains unchanged and healthy during all dogfood cases;
- automated gates, desktop Browser QA, and 390 px Browser QA are green;
- no merge, release, Production deploy, or infrastructure mutation occurs without its separately required approval.

## Infrastructure snapshot from planning

Read-only checks on 2026-07-22 found:

- `pr-263.projects.os-home.net` currently has no A record, so DNS routing for the chosen same-origin hostname convention is not yet ready;
- the existing Clerk integration verifies bearer tokens with the shared secret but does not currently bind `verifyToken` to `authorizedParties`, so exact Preview-origin verification must be added in the trusted gateway;
- the existing GitHub integration uses one OAuth application with user-scoped stored tokens and requests `repo read:user`; the Preview gateway must reuse that connection without falling back to a global token or exposing stored tokens to PR code;
- no existing Preview runtime paths or containers;
- the VPS filesystem at 81% usage with roughly 93 GB free;
- substantial reclaimable Docker images and build cache, but no current Preview quota or cleanup policy.

These values are planning evidence, not a durable contract. They must be rechecked immediately before infrastructure bootstrap and dogfooding.
