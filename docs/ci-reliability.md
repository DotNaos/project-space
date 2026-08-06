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

The trusted release-entry workflow stays separate because pull-request code
must not be able to alter the validator that writes its own required result. A
ready pull request is checked immediately and later head changes are rechecked.

## Canonical local preflight

Run the repository-owned preflight against a committed, clean revision:

```sh
bun run ci:preflight --base origin/main --head HEAD --pull-request 466 --format json
```

The preflight uses the same changed-path selection as `Fast CI`. The ordinary
path therefore avoids docs, mobile, Go, workflow, and platform work when those
surfaces are untouched. A pull-request number enables exact PR-owned release
entry validation; without one, the current release catalog is checked.

The report records exact base and head commits, changed paths, selected lanes,
commands, durations, conclusions, and relevant protected remote-only gates. It
refuses a dirty checkout or a requested head other than the checked-out `HEAD`,
because otherwise the report could name code that was not actually tested.

Release-critical changes select all local extras. On macOS the preflight also
runs the native macOS packaging contract. Foreign-host packaging, production
signing, immutable publication, Preview credentials, VPS access, rollback,
TLS, exact remote identity, and health remain remote-only.

The expected feedback target under normal runner availability is two to five
minutes for an ordinary pull request. Release-critical changes are allowed to
take longer rather than weakening their required proof.

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

An ordinary approved merge to `main` dispatches Production for that exact
commit without manufacturing a new GitHub Release or rebuilding every tool.
The Production target is the VPS at `projects.os-home.net`, never Vercel.

Versioned Project CLI, connector, installer, and machine-tool publication uses
a short-lived release pull request. A true release pull request is prepared and
merged on `main`; `release-from-main.yml` creates its exact version tag and
explicitly dispatches `release.yml` once. `release.yml` is manual tag-dispatch
only, so a tag push cannot start a duplicate release.

Each `main` push keeps its own non-cancelling handoff. An hourly or manual
reconciliation pass also walks the release entries on `main`, validates their
exact addition commits, and resumes the oldest missing or failed exact-tag
Release run before moving to the next version.
Older unpublished entries below an already published version stay superseded.
This makes runner or webhook outages recoverable without duplicating a Release
or Production dispatch.

The immutable Release run retains full platform builds, isolated no-checkout
signing jobs, artifact provenance, digest and manifest verification, GitHub
publication, and the protected Production handoff where required. The previous
one-step release-to-production wrapper is inlined into the owning flow.

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
