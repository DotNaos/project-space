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

The always-on documentation workflow now skips only the numbered entry step
for drafts. Generated CLI documentation, documentation type checks, and the
documentation build still run. `ready_for_review` is an explicit trigger, so a
draft cannot become ready without immediately entering both the documentation
and trusted latest-main entry gates.

## Canonical local handoff

Run the repository-owned preflight against a committed, clean exact revision:

```sh
bun run ci:preflight --base origin/main --head HEAD --pull-request 435 --format json
```

The optional pull-request number enables exact PR-owned release validation. A
run without it validates the current catalog and is suitable for the coherent
draft revision used to obtain a PR number. The JSON report includes schema
version, exact base and head SHAs, changed paths, the same release verification
classification used by GitHub, every command and result, duration, and every
protected remote-only gate. Child command output is written to stderr so stdout
remains one machine-readable document.

The command refuses a dirty worktree because otherwise `HEAD` would not name
the content that was actually tested. Documentation, TypeScript, the full Bun
test suite, web, mobile Expo, and locked dependency checks run for every PR
because the documentation and Preview workflows are unconditional. Go
race/vet, workflow lint, shell syntax, and host-native packaging are selected
from the changed-path/release-matrix contract. Foreign-host packaging, signing,
artifact and receipt handoffs, Preview/VPS access, TLS, capacity, rollback,
exact remote identity, and health remain explicitly remote-only and fail
closed.

The Release trigger now includes every trust and policy path classified as
release-critical. A change to the classifier, its composite action, approval
signing, packaging, or the preflight/release helpers therefore cannot bypass
the matrix by making the classifier unreachable.

## Atomic release preparation

After the draft has a number, author a complete
`apps/docs/content/docs/releases/entries/<PR>.mdx`. Use `__VERSION__` and
`__PR_NUMBER__` only for those two frontmatter values, then run from an
otherwise clean worktree:

```sh
bun run release:prepare --pull-request 435 --version 0.4.56 --format json
```

The helper refreshes current main, verifies ancestry and the intended Semantic
Versioning bump, rejects existing tags or GitHub Releases, validates the full
catalog, and updates these identities as one rollback-capable transaction:

- root package version;
- connector development identity;
- Windows packaging version and release URL;
- rendered Windows installation example;
- connector and release contract fixtures;
- the PR-owned entry identity.

Staged changes, unrelated changes, incomplete bundles, stale main/version
input, schema errors, duplicate versions, and occurrence-count drift are
refused before writing. A second invocation succeeds only when the exact seven
path bundle is already prepared and byte-stable.

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

Preview transactions remain serialized so a remote apply is never cancelled
mid-operation. Instead, the trusted workflow binds automatic work to the event
head, classifies a positively newer or closed PR before credential handoff, and
skips the outdated transaction neutrally. After handoff, exit code 75 is neutral
only when a fresh GitHub read positively proves that the requested head was
superseded or closed. API uncertainty, a current-head exit 75, a receipt error,
or a runner that did not positively refuse the stale head remains failed. A
manual GitHub deployment proven superseded is marked inactive; current exact
heads retain every identity, receipt, capacity, TLS, and health requirement.

## First-push measurement window

The post-#425 audit through PR #433 is the baseline: 81 PR-event runs, 35
successful, 24 cancelled, 21 failed, and one running. Roughly 12 failures were
locally preventable; 20 cancellations came from one drip-fed version bundle.

For each of the next five representative PRs, record the exact head, change
surface, first-push local-preflight result, first required remote conclusion,
time to required green, avoidable failures, cancellations, feedback duration,
and summed runner minutes. Do not count a superseded neutral/cancelled Preview
as a product regression, and do not hide infrastructure, protected Preview,
release, or production failures. The comparable after window is complete only
after five PRs; this implementation cannot fabricate future delivery data.

The read-only snapshot in `docs/open-pr-ci-inventory-2026-07-31.md` records the
legacy starting state. Refresh it with
`bun run ci:inventory:open-prs --format markdown --output <docs/path.md>`.
The report never edits or closes an unrelated branch and never rewrites a stale
historical check.

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
post-merge observations.

The first successful live full-matrix PR run after the parallel change
(`30608644674`, exact head
`035ec5a3c10d13e1822020779cc01ad5fbdf3cbc`) took 3.27 minutes from the first
job start through the policy result, compared with 6.38 minutes for the
immediately preceding successful run (`30605646887`). That is 48.8% less
feedback time. Summed non-skipped job time was effectively unchanged at 8.67
minutes versus 8.62 minutes, because the independent lanes add checkout and
setup time while shortening the critical path.

Using the observed classification, shared-quality, trust-root, Linux,
aggregation, and policy durations from that same run, an ordinary patch would
have completed in about 1.92 minutes and used about 4.83 runner minutes. The
historical patch-path medians were 4.48 and 4.35 minutes respectively. The
measured result therefore trades about 11% more runner time for about 57% faster
feedback. Later samples should separate cold and warm exact-cache runs.

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
