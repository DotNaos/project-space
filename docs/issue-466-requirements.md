# Issue #466: CI, Preview, Release, and PR Dev Builds

## Goal

Make normal pull requests easy to understand and ready to merge in roughly two to five minutes without weakening release, signing, Preview, or production safety.

## Pull requests

- A normal pull request has two merge-relevant results:
  - `Fast CI`
  - the trusted exact-head `Release decision`
- `Fast CI` uses one Ubuntu runner and one dependency installation for the common TypeScript, test, and web-build path.
- Documentation, mobile, Go, workflow, shell, and platform checks are selected from the changed paths. Release-critical or ambiguous changes fail closed to the broader checks.
- The canonical local preflight uses the same selection policy as GitHub and targets the same two-to-five-minute normal path.
- Expensive platform packaging, signing, publishing, and production jobs do not appear as skipped checks on ordinary pull requests.

## Pull-request Previews

- Every internal pull request keeps one isolated Preview deployment at its exact current head.
- Preview build and deployment remain separate trust boundaries: pull-request code never receives Preview credentials.
- The non-blocking Preview artifact job starts only after `Fast CI`, so it cannot take the first available runner away from merge feedback.
- Preview work does not block merging unless a required Preview contract itself is changed.
- Start, stop, touch, deploy, destroy, closed-PR cleanup, and scheduled reaping share one trusted Preview-control workflow.
- A superseded head must never replace or report itself as the current Preview.

## Production and releases

- There is one Production environment and no permanent `develop`, staging, or release branch.
- Approved merges land on `main`; `main` is the source of the production deployment.
- An ordinary merge may deploy the exact `main` commit without creating a new GitHub Release or rebuilding every distributable tool.
- Versioned Project CLI, connector, installer, and machine-tool releases use a short-lived release pull request against `main`.
- Merging a release pull request creates exactly one version tag and exactly one immutable release run.
- The release run retains full platform builds, isolated production signing, artifact provenance, manifest verification, publication, and the protected production handoff when required.
- Release-critical runtime changes remain backward compatible or inactive until their matching signed release is available.
- Rollback redeploys a previously verified `main` commit; it does not rely on a long-lived release branch.

## On-demand PR dev builds

- CLI and connector dev builds are never automatic, even when a pull request changes those files.
- A user explicitly requests a dev build for an open pull request and selected platform(s).
- The request binds to the exact current PR head. A moved or closed PR makes the result superseded rather than current.
- A successful existing artifact for the same PR, head, and platform is reused.
- Dev builds are non-blocking, short-lived artifacts and never create a tag or GitHub Release.
- Artifact identity includes repository, pull-request number, full commit, platform, build time, checksums, and development channel.
- Production signing identities and production trust roots are never exposed to or used for pull-request code.
- Dev CLI and connector bundles use separate executable and artifact names and cannot replace or register as stable production installations by default.
- Installers and production-signed helpers remain release-only until they have an equally isolated unsigned development contract.

## Workflow cleanup

- Replace the PR-facing documentation and release-quality workflows with one clear CI workflow.
- Fold Preview cleanup, reaping, and artifact promotion into the trusted Preview-control workflow while preserving job-level permissions and concurrency.
- Inline the one-step release-to-production dispatch wrapper.
- Keep the one out-of-band delivery-evidence workflow because it can still record a sanitized result when an owning delivery run is cancelled; do not add separate evidence workflows for individual delivery stages.
- Remove the completed macOS signing and signing-secret probe workflows after their security assertions are covered against the real signer workflows.
- Disable retained GitHub workflow records for deleted legacy workflows such as `CI` and `PR Canary` after the replacement reaches `main`.

## Required safety properties

- Exact commit, artifact ID, digest, source repository, and current-head checks remain fail closed.
- Fork pull requests and untrusted pull-request jobs receive no deployment or signing secrets.
- Signing secrets remain limited to protected no-checkout signing jobs.
- Pull-request verification may be cancelled when superseded; Preview transactions, releases, publication, and production deployment may not be cancelled mid-operation.
- Production remains the VPS deployment at `projects.os-home.net`; Vercel is not a production target.
- Failed delivery evidence is sanitized and contains no raw logs or secret-shaped values.

## Acceptance criteria

- A representative ordinary pull request reaches required green in two to five minutes under normal runner availability.
- Its Checks view contains no release-only signing, publication, or production jobs.
- The local normal preflight follows the same selected lanes and completes in the same general time budget.
- Every PR still receives one exact-head Preview, independently of merge readiness.
- Dev builds run only after an explicit request and are clearly isolated from stable tools and Production.
- One release pull request produces one tag, one release run, verified published artifacts, and any required exact production deployment.
- The active workflow inventory no longer contains deleted legacy or diagnostic workflows.
