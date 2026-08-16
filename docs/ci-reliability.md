# CI reliability and delivery policy

Project Space optimizes ordinary pull requests for fast, understandable
feedback while keeping Preview, release, signing, and Production trust
boundaries fail closed.

## Pull-request checks

An ordinary pull request has two merge-relevant results:

- `Fast CI` tests the source on one Ubuntu runner.
- `Release decision` validates the exact pull-request head from trusted
  `main` workflow code.

`Fast CI` performs one root Bun installation, then always runs the package
manager policy, TypeScript checks, the Bun test suite, and both web builds. It
selects these additional lanes from the exact base-to-head changed paths:

| Changed surface | Additional local proof |
| --- | --- |
| Documentation app | Frozen docs install, type check, and build |
| Project CLI or generated CLI reference | CLI contract tests and generated-doc check |
| Mobile app | Frozen mobile install and prototype build |
| Go source or modules | Race-enabled tests and `go vet` |
| Workflows, deployment, packaging, or CI scripts | `actionlint` and shell syntax |

A missing changed-path set, a version change, or a release-critical path
selects every additional lane. This is intentional: uncertain changes become
broader checks rather than silently skipping relevant proof.

Superseded pull-request CI is cancelled by pull-request number. Preview
transactions, release publication, signing, and Production deployment are not
cancelled mid-operation.

The trusted release-intent workflow stays separate because pull-request code
must not be able to alter the validator behind its normal `Release decision`
Actions job. A ready pull request is checked immediately and later head changes
are rechecked. If infrastructure interrupts that job, rerun the original
pull-request job; a manual run on `main` cannot prove an arbitrary PR head.

## Canonical local preflight

Run the fast repository-owned preflight against a committed, clean revision:

```sh
bun run ci:preflight --base origin/main --head HEAD --pull-request 466 --format json
```

This default profile uses changed paths to select relevant local extras. It avoids
docs, mobile, Go, Rust, workflow, and platform work when those surfaces are untouched,
even when GitHub's release policy requires broader remote proof. It is the short local
feedback loop, not a claim that every GitHub lane has run.

Run the optional full profile when you want comprehensive local proof:

```sh
bun run ci:preflight:full --base origin/main --head HEAD --pull-request 466 --format json
```

The full profile runs all locally reproducible `Fast CI` lanes plus the release-quality
TypeScript check, using the same shared repository commands as Actions. On macOS it also
runs the native macOS packaging contract. A pull-request number enables exact PR-owned
release intent validation; without one, the historical release catalog is checked.

The report records exact base and head commits, changed paths, selected lanes,
commands, durations, conclusions, and relevant protected remote-only gates. It
refuses a dirty checkout or a requested head other than the checked-out `HEAD`,
because otherwise the report could name code that was not actually tested.

The report records both the requested local profile and GitHub's independent release
policy decision. Foreign-host packaging, production signing, immutable publication,
Preview credentials, VPS access, rollback, TLS, exact remote identity, and health
remain remote-only and are listed explicitly rather than simulated locally.

The expected feedback target under normal runner availability is two to five minutes
for the fast profile. The full profile is intentionally allowed to take longer.

## Shared checks and pre-commit feedback

Repository quality commands are defined once and addressed by a stable check ID.
GitHub Actions and `ci:preflight` call the same runner that developers can invoke:

```sh
bun run ci:check -- package-manager-policy docs-specs
bun run ci:check -- tests web-build
```

Run `bun run ci:preflight` for fast changed-path-selected feedback. Run
`bun run ci:preflight:full` for comprehensive local CI and release-quality proof. Individual IDs
are useful for repeating one failed lane, but they do not replace the clean-revision,
base/head, capacity, changelog, and final-cleanliness guarantees of either preflight.

The trusted `lefthook` Bun dependency installs the repository hook during a normal
dependency installation. Before a commit, Lefthook runs diff hygiene, package-manager
policy, and documentation/change-spec validation in parallel. These checks read the
staged Git index, so unrelated unstaged work cannot hide or create a failure. Run the
same profile directly with:

```sh
bun run check:pre-commit
```

Git still permits an intentional one-off bypass with `git commit --no-verify`, and
Lefthook can be disabled for one command with `LEFTHOOK=0`. A bypass never weakens CI:
the shared checks run again against the exact pull-request revision. Signing,
publication, Windows-only validation, Preview, and Production remain protected or
remote-only gates and are reported as such by local preflight.

## Pull-request Previews

Every internal pull request receives one Preview for its exact current head.
Preview work is not a normal merge gate.

The untrusted artifact build and trusted artifact promotion remain separate:
pull-request code never receives Preview credentials. The trusted Preview
control workflow owns deploy, start, stop, touch, destroy, closed-PR cleanup,
and scheduled or manual reaping. It revalidates the repository, pull-request
number, current head, artifact IDs, and digests before credential handoff.

The untrusted Preview artifact job is ordered after `Fast CI` in the same
pull-request workflow. On repositories with a small runner allowance, Preview
work therefore cannot take the first available runner away from required merge
feedback.

A superseded or closed pull request cannot publish itself as the current
Preview. Capacity limits are reported distinctly from product failures. Ready
still requires the expected images, runtime metadata, TLS hostname, health,
and public-origin checks.

Delivery transition evidence stays out of band. Inlining it would lose the
ability to preserve sanitized evidence when a workflow itself is cancelled.

## Production and versioned releases

Project Space has one Production environment and no permanent development,
staging, or release branch.

Every pull request adds one immutable `none`, `patch`, `minor`, or `major`
intent and keeps the concrete package version unchanged. One global,
non-cancelling queue walks first-parent `main` history from the latest
published signed release. It always selects the oldest release-bearing merge,
derives the next version only after merge, reserves that exact tag, and
dispatches `release.yml` once. Concurrent pull requests therefore cannot claim
the same version or block one another before merge.

`release.yml` is manual tag-dispatch only, so a tag push cannot start a
duplicate release. Publication wakes the queue again; the queue continues with
the next intent, or dispatches Production for current `main` using the latest
compatible published signed version once it is drained. The scheduled and
manual wake-ups use the same durable tag and run recovery rules, making runner
or webhook outages recoverable without duplicating Release or Production.

The immutable Release run retains full platform builds, isolated no-checkout
signing jobs, artifact provenance, digest and manifest verification, GitHub
publication, and the protected Production handoff where required.

The `release-signing` GitHub environment is an automatic secret boundary, not
a human approval gate. It has no required reviewers or wait timer, is limited
to protected branches, and alone permits the fixed Infisical release-signing OIDC identity
used to load the dedicated manifest key. The reusable signer is callable only
from the trusted release workflow; pull-request and fork workflows cannot enter
the environment or receive its secrets. Signing still fails closed unless the
queued SHA is on current `main`, the tag and immutable artifact provenance
match, the private key derives the committed trust root, and the resulting
signature verifies.

Repository administrators apply or repair that boundary with
`scripts/configure-release-signing-environment.sh OWNER/REPOSITORY`. The script
idempotently removes required reviewers, keeps protected-branch restriction,
and reads the environment back to verify that no interactive rule remains. If
the environment or Infisical OIDC exchange is unavailable, the release stops at the
signer and the serial queue can be woken again after configuration is repaired;
never bypass signing or publish the prepared unsigned manifest.

Release-critical runtime changes must remain backward compatible or inactive
until their matching signed tools are available. Rollback redeploys a
previously verified `main` commit; it does not depend on a long-lived release
branch.

## On-demand pull-request dev builds

CLI and connector development builds never run automatically. A
user explicitly requests selected platforms for an open pull request. The
request binds to the exact current head and reuses an existing successful
artifact for the same repository, pull request, commit, and platform.

These artifacts are short-lived, non-blocking, clearly marked as development
builds, and never create a tag or GitHub Release. They use separate executable
names and storage and cannot replace stable installations by default.
Production signing identities and production trust roots are never exposed to
pull-request code. Installers and production-signed helpers stay release-only
until an equally isolated unsigned development contract exists.

## Fail-closed delivery properties

- Exact source commit, current PR head, artifact ID, digest, and repository
  identity are checked at every trust-boundary handoff.
- Fork pull requests and untrusted jobs receive no deployment or signing
  secrets.
- Signing secrets remain limited to protected no-checkout jobs.
- Published artifacts are immutable and verified before Production handoff.
- Failed delivery evidence is bounded and sanitized rather than copying raw
  logs or secret-shaped values.
- Production success requires the exact remote checkout, running version,
  health checks, and reachable public origin; a green workflow alone is not
  deployment proof.

## Measurement

After rollout, measure at least five representative ordinary pull requests.
Record time to required green, runner wait, selected extras, total runner time,
avoidable failures, and cancellations. The two-to-five-minute target is met
only by live results under normal runner availability, not by a local estimate.
