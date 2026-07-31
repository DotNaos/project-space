# CI reliability and verification policy

This document records which CI states are failures, which are deferred or
capacity-blocked, and when Project Space requires full platform verification.
None of these distinctions bypasses an exact-head, security, signing, release,
deployment, rollback, or health gate.

## Pull request release-entry checks

`Versioned release entry` remains an exact-head check produced by the trusted
validator from an exact `main` revision.

- A directly opened, non-draft pull request is checked immediately.
- A draft is not checked until `ready_for_review`.
- Later non-draft synchronizations are checked.
- A `main` push revalidates every non-draft open pull request.
- An invalid candidate keeps its own exact-head check failed, but does not turn
  the aggregate `main` revalidation run red.
- A completed check is reused only when both its exact PR head and exact
  trusted-main input are unchanged.

One-time migration for pull requests created before this contract:

1. Record each open pull request's exact head.
2. Convert a legacy pull request to draft while its numbered MDX entry is
   missing. This changes no merge, review, or branch protection rule.
3. Add the PR-owned release entry and the corresponding version change against
   current `main`.
4. Mark it ready for review. The normal exact-head/latest-main check must pass.
5. Resolve duplicate or stale versions normally; do not fabricate a passing
   placeholder.

## Pull request verification matrix

The policy fails closed to the full matrix when its version or changed paths
are missing or ambiguous.

| Change | TypeScript/web | Mobile Expo | Go race/vet | Trust roots | Linux artifact | Windows | macOS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ordinary sequential patch | required | required | required | required | required | skipped | skipped |
| Minor or major version | required | required | required | required | required | required | required |
| Release candidate or ambiguous version | required | required | required | required | required | required | required |
| Platform-specific or release-critical path | required | required | required | required | required | required | required |
| Tag release or on-demand verification | required | required | required | required | required | required | required |

Classification now finishes before the independent TypeScript/web, mobile Expo,
Go race/vet, trust-root, and selected platform lanes start. TypeScript tests and
web builds, the mobile Expo export, race-enabled Go tests, and Go vet therefore
remain mandatory for every release pull request without forming one serial
queue. The Linux lane proves the release artifact and exact trust-root handoff.
The final policy requires the complete shared-quality workflow and every
selected platform to succeed; a missing required lane fails.

Linux no longer repeats targeted Go tests and vet already covered on the same
Ubuntu source by the mandatory Go lane. Windows retains its native packaging,
platform-specific tests, Go verification, binary and installer builds, and
WinGet validation, but no longer repeats the cross-platform TypeScript check.
Exact Bun package-download caches have no broad fallback: their keys bind the
runner OS, architecture, Bun 1.3.14, and exact lockfile hash. `bun install
--frozen-lockfile` still validates every restored download.

Inno Setup is deliberately not cached. Its installer download is checksum
verified, but the current installer script does not authenticate a restored
installed compiler tree before use. Caching that tree would trade speed for an
unverified release input.

Release-critical classification includes release workflows and their policy
action, dependency manifests, packaging, approval signing, machine connection,
self-update, platform-suffixed Go files, connector source/tests, PowerShell, and
the policy implementation itself. Ambiguous changes use the full matrix.

Superseded pull request runs are cancelled by PR number. Tag and on-demand
release runs remain non-cancelling.

## Release and production sequencing

`Publish merged release` validates the merged release entry, creates the exact
tag, and starts the immutable Release workflow. That workflow builds and
verifies the required platform artifacts, signs and publishes the exact release,
then dispatches production for the published source SHA.

Production no longer starts independently on every `main` push. If the required
signed connector release is absent during an authorized manual recovery, the
result is `deferred` and production remains untouched. Exact commit, version,
artifact, signature, connector-drift, remote checkout, running build, rollback,
health, and live-origin verification remain fail-closed.

Failed Preview, Release, and Production transitions publish bounded
machine-readable evidence. Logs are not copied wholesale. Preview and
Production evidence redacts credential-shaped values before upload; Release
evidence records only job names, conclusions, times, identity, and links.
Stable failure classes distinguish `invalid_change`, `expected_deferred`,
`capacity_block`, `infrastructure_failure`, `flaky_test_signature`, and
`application_regression`; successful transitions use `none`.

## Preview capacity and TLS

A full slot quota or low storage reserve is `blocked_capacity`, not an
application regression. The trusted runner persists the requested repository,
PR, and head identity with `preview_quota_full` or `preview_storage_low`. The
GitHub deployment remains pending with a clear capacity description, while the
workflow finishes without a misleading product-failure notification.

Ready is stricter: the runner verifies the certificate with the exact public
hostname as both TLS server name and hostname before checking the exact PR head,
images, runtime metadata, prototype metadata, health, and public origin.

The four Preview images now build concurrently through one trusted Buildx Bake
plan. The PR checkout remains only the web, docs, and prototype source context;
all Dockerfiles, the gateway context, and prototype trusted assets come from the
exact trusted workflow checkout. Deployment still receives only four validated
immutable digests. No shared registry cache is used.

## Measured baseline and expected patch-path effect

Measured on 2026-07-30 from the latest 25 successful `Release` pull-request runs
available at implementation time. Runner minutes are the sum of non-skipped job
durations. Feedback time is the first job start through the final non-skipped
job completion. The patch-path result uses the observed quality, trust-root,
and Linux job durations from those same runs; it does not estimate job speed.

| Measure | Existing full PR matrix | Measured patch path | Change |
| --- | ---: | ---: | ---: |
| Median feedback | 6.58 min | 4.48 min | -31.9% |
| p95 feedback | 10.38 min | 4.87 min | -53.1% |
| Median runner use | 8.65 min | 4.35 min | -49.7% |
| p95 runner use | 12.63 min | 4.65 min | -63.2% |

The small policy job is not present in the historical sample, so live
post-merge measurements should include its runtime. It is bounded to five
minutes and performs no checkout or build.

The parallel follow-up uses measured step components from the current workflow:
about 19 seconds for a root Bun install, 105 seconds for TypeScript checks,
tests, and builds, 43–46 seconds for the mobile Expo portion, and 48 seconds for
Go race tests and vet. It also removes about 17 seconds of duplicate Linux Go
checks and about 21 seconds of duplicate Windows TypeScript work. Those
components support a roughly 1.75–2.25 minute ordinary-patch feedback target
and a roughly 3.5 minute full-matrix target, but they are forecasts rather than
post-merge observations. Cache hits and runner use must be measured from live
runs after merge; splitting lanes adds small checkout/setup overhead even while
reducing wall-clock feedback.

The five most recent successful Preview image stages before the Bake change took
5.32–5.82 minutes because web, docs, prototype, and gateway were built one after
another. Their latest individual build times were about 2.10, 1.03, 1.23, and
0.45 minutes. Concurrent execution therefore has a structural target of roughly
2.5–3 minutes for the same stage, including setup and metadata validation. This
is also a forecast until a live trusted Preview run records the after state.

The preceding 48-hour audit found 54 failed workflow runs, including 31 manual
retries. The new contracts remove the known avoidable red classifications
without relabelling genuine failures:

| Audited pattern | Before | New contract |
| --- | ---: | --- |
| Invalid open PRs making one aggregate main gate red | 16 failing matrix jobs in the cited run | PR checks fail; aggregate run succeeds |
| Preview quota exhaustion | 4 failed runs | pending `blocked_capacity` |
| Expected connector-release drift | 6 failed production runs | production is not started before publication |
| Confirmed unchanged-retry flakes | 7 failed attempts | deterministic tests with repeat coverage |

Draft-first failures are prevented by trigger semantics. The after state above
is a contract result, not a fabricated 48-hour production observation. A
comparable live window should be recorded after merge; genuine regressions,
infrastructure failures, and invalid PR checks must remain red.
