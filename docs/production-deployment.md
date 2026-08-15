# Production deployment

Project Space production runs on the VPS and is served at
<https://projects.os-home.net>. Vercel is not part of this deployment path.

## Automatic path

The serial release queue starts `.github/workflows/deploy-production.yml` only
after all merged release intents have been published. The workflow uses one
non-cancelling concurrency lane named `project-space-production`:

1. Check that the requested value is a full SHA and still equals current
   `main`.
2. Run Bun tests, type checking, the production build, Go tests, Go vet, the Go
   build, and the exact-commit CLI dry run without production credentials.
3. Enter the GitHub `Production` environment.
4. Authenticate to Infisical with the fixed Production OIDC identity, load only
   the Production project credentials, and join
   Tailscale as the ephemeral `tag:ci-project-space-deploy` identity.
5. Run `project deploy --env prod --commit <sha> --release-version <version> --format json` over pinned SSH.
6. Independently compare GitHub `main`, the VPS checkout, running build
   metadata, service health, `/api/health`, and the live page.

Only a result with matching checkout, image revision, running-build metadata,
healthy Compose services, healthy HTTP, and a reachable live origin is success.
A checkout by itself is never deployment evidence.

## States and rollback

The machine-readable flow reports `checking`, `validating`, `lock`, `deploy`,
`verify`, and `success`. Terminal alternatives are:

- `superseded`: a newer `main` commit exists; production was untouched.
- `failed_before_deploy`: validation or rollback-target establishment failed;
  production was untouched.
- `blocked`: the shared production lock was not acquired before its timeout.
- `rollback_succeeded`: rollout failed and the last verified release was
  restored and fully reverified. The attempted GitHub deployment still fails.
- `rollback_failed`: neither the requested release nor rollback passed the full
  verification contract. Investigate immediately.

The last verified SHA and its independently assigned signed version are stored
atomically on the VPS under
`/opt/platform/state/project-space-prod/verified.release`; `verified.sha`
remains as compatibility evidence. Rollback cannot accept an arbitrary stale
SHA or guess its version from `package.json`: it is restricted to that
server-recorded release and stays inside the same kernel lock as the failed
rollout.

## Manual recovery

The normal recovery entry is GitHub Actions **Publish merged release → Run
workflow**, selecting `main`. It recomputes the oldest pending release and the
latest compatible signed version before starting or recovering Production.

Using the GitHub CLI:

```sh
gh workflow run release-from-main.yml --ref main
```

An operator with the existing VPS deployment access can use the identical
server-side contract:

```sh
commit="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
version="<published-compatible-version>"
./bin/project deploy --env prod --commit "$commit" --release-version "$version" --format json
./bin/project deploy status --env prod --format json
```

Manual and automatic commands use the same lock; they cannot overlap.

## GitHub Production configuration

The `Production` environment contains no long-lived secret-delivery token. The
workflow requests a short-lived GitHub OIDC token and Infisical accepts it only
for the fixed Project Space Production identity and exact environment subject.
It contains these non-secret variables:

- `PROJECT_SPACE_DEPLOY_IP`: the VPS Tailscale IP.
- `PROJECT_SPACE_SSH_KNOWN_HOSTS`: the pinned SSH host-key line.

The delete-protected `project-space-production` Infisical project contains the
deploy SSH key, the two Tailscale OAuth credential fields restricted to
`tag:ci-project-space-deploy`, the application deployment secrets, and the two
provider-credential encryption values. The encryption key is a 32-byte Base64
value; its separate key ID is stored with encrypted account-owned credentials
for explicit version checks.

Only the protected deployment job receives these values. The Project CLI sends
the fixed deployment script over pinned SSH and writes the VPS runtime `.env`
atomically with mode `0600`. Deployment stops before contacting the VPS when
either provider-encryption value is missing. The VPS does not authenticate to
GitHub or Infisical to read these values itself.
The tailnet policy permits that CI tag to reach only the VPS on TCP port 22.
Do not print, upload, or add any resolved value to workflow summaries.

## Safely disable automatic deployment

Disable the workflow when production must stop accepting new automatic runs:

```sh
gh workflow disable deploy-production.yml
```

This does not cancel an already running rollout. Let the active lock holder
finish or roll back, then inspect:

```sh
./bin/project deploy status --env prod --format json
```

Re-enable the trigger with `gh workflow enable deploy-production.yml`, then run
the manual recovery workflow for current `main` if production is behind.
