# Cryptographic human approvals

`project approval` verifies repository-declared review scopes without treating repository files as their own authority.

## Repository contract

The default policy is `.project/approvals/policy.yaml`:

```yaml
version: 1
repository: github.com/DotNaos/ui
policyId: source-review
scopes:
  - id: button
    label: Button primitive and stories
    paths: [src/components/button, stories/button]
    ignore: ["**/*.snap"]
    attestation: .project/approvals/button.json
```

Paths are repository-relative. Symlinks in any path component and paths escaping the repository are rejected. Files are streamed into individual hashes in sorted slash-normalized order. Every normalized history sidecar declared by the policy is excluded from every scope hash, preventing one newly signed scope from making another stale.

New sidecars are version-2 append-only histories. Every signed event binds its operation (`approve` or `revoke`), strictly increasing sequence, previous signed-event digest, repository identity, policy identity and digest, stable scope identity, complete file list and hashes, content digest, signer fingerprint, and issue time. Each event signature is DER-encoded ECDSA P-256 over SHA-256 of canonical payload JSON. The next event chains the SHA-256 digest of the complete previous signed event. Sidecars contain no unsigned approval or revocation boolean.

Policy changes intentionally require a new external enrollment: the external trust root pins the canonical policy digest. This prevents an agent from deleting scopes or weakening ignores and then declaring success.

## Commands

```sh
project approval enroll --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json"
project approval prepare --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json" --checkpoint "$HOME/.config/project/trust/ui.checkpoint.json" --scope button --format json
project approval status --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json" --checkpoint "$HOME/.config/project/trust/ui.checkpoint.json" --format json
project approval sign --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json" --checkpoint "$HOME/.config/project/trust/ui.checkpoint.json" --scope button --expected-content-digest DIGEST --format json
project approval revoke --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json" --checkpoint "$HOME/.config/project/trust/ui.checkpoint.json" --scope button --expected-content-digest DIGEST --format json
project approval verify --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json" --checkpoint "$HOME/.config/project/trust/ui.checkpoint.json" --format json
```

`prepare` is read-only and returns the repository, policy, stable scope, current sorted file manifest and digest, signer, current verified state, and next chain position. A local bridge should pass its returned digest back through `--expected-content-digest`; the signing command independently recomputes every trusted value and refuses to prompt if covered content changed. It recomputes again after authentication and writes nothing if content changed while the system prompt was visible.

`PROJECT_APPROVAL_TRUST_ROOT` and `PROJECT_APPROVAL_CHECKPOINT` provide externally configured defaults. If the checkpoint is omitted, the CLI derives `<trust-root>.checkpoint.json` for command compatibility. Browser callers must never choose these paths, the repository root, policy, executable, flags, or scope. A trusted bridge maps a fixed route and allowlisted scope to fixed administrator-owned configuration.

Enrollment and signing use the macOS Secure Enclave through the bundled `project-approval-signer` component. A trusted Project CLI build accepts only its adjacent Apple-signed DotNaos helper and pins that helper's exact SHA-256 digest inside the CLI at build time. Replacing the helper therefore also requires replacing the externally pinned Project CLI. No environment or repository path can select another helper. The private key is non-exportable. CryptoKit stores only its device-bound opaque representation under the user's Application Support directory, and every signing operation uses a fresh LocalAuthentication context with authentication reuse disabled. Approval and revocation each produce a separate system prompt binding operation, repository, policy, stable scope ID, current content digest, sequence, and previous event digest. Cancellation writes neither history nor checkpoint.

On macOS, the signed helper also owns a per-scope monotonic anchor in the Data Protection Keychain using `WhenUnlockedThisDeviceOnly`. The CLI can read it, but an update succeeds only when the helper verifies the freshly produced Secure Enclave signature and the previous anchor matches exactly. The helper exposes no deletion or rollback operation. Restoring an older repository history and its matching external checkpoint therefore still fails as `replay_checkpoint_mismatch`. Losing the protected Keychain item is a fail-closed recovery event; repository material cannot recreate it.

Verification is pure Go and portable. Signing fails honestly on non-macOS systems or when the trusted signed helper is absent. `project validate` also verifies approvals when the default policy exists; it fails closed unless `PROJECT_APPROVAL_TRUST_ROOT` points at an external trust root.

The macOS machine-tools bundle includes the helper. During rollout, the connector installer remains compatible with bundles that do not yet contain the helper: those installations keep working, while approval enrollment/signing remains unavailable until a new signed bundle is published and pinned.

## External fail-closed enforcement

A repository script, workflow, public key, or CLI binary built from the checkout is not trusted against an agent that can edit the checkout. The RL runner or CI administrator must own the gate outside the workspace:

```sh
/opt/project-trust/bin/project approval verify \
  --root "$UNTRUSTED_CHECKOUT" \
  --policy .project/approvals/policy.yaml \
	--trust-root /etc/project-trust/ui.json \
	--checkpoint /etc/project-trust/ui.checkpoint.json \
	--format json
```

The runner must make `/opt/project-trust/bin/project`, its expected code signature or artifact hash, `/etc/project-trust/ui.json`, `/etc/project-trust/ui.checkpoint.json`, and the invocation itself inaccessible for writes or rollback by the repository agent. The checkpoint is mutable only by the trusted bridge or operator. Merely placing it outside the checkout is insufficient if the repository agent runs with equivalent filesystem authority. The CLI rejects trust-root and checkpoint paths that resolve inside the repository.

The external checkpoint pins the latest accepted sequence, complete signed-event digest, operation, and content digest for each scope. On macOS, status and preparation additionally require an exact match with the helper-owned protected anchor. Missing history while either checkpoint exists is `missing_history`; malformed or broken signed chains are `invalid_tampered`; restoring an older history, forking the tip, or rolling either file side independently is `replay_checkpoint_mismatch`. Only an exact signed history/checkpoint match can be `approved` or `revoked`. Portable non-macOS verification continues to rely on a runner-owned external checkpoint whose write and rollback authority is outside the repository agent.

[`packaging/macos/trusted-approval-gate.sh`](../packaging/macos/trusted-approval-gate.sh) is the installable runner contract. An administrator copies it outside the checkout and pins both the preinstalled Project CLI hash and trust-root hash in runner-owned configuration. Running the copy in the repository is not trusted.

## UI and project-template integration

The UI repository can map Storybook component IDs to stable policy scope IDs. A development overlay may call `project approval status` and write unsigned review notes, but only `project approval sign` can create approval truth. Guard the overlay with a compile-time development condition and assert the production bundle contains neither its module nor approval controls.

`project-template` uses the identical policy schema. Its trusted validation environment sets `PROJECT_APPROVAL_TRUST_ROOT` and runs `project validate`; the adversarial gate still invokes the preinstalled verifier directly as shown above. Trust roots are never copied into generated repositories.

## Rotation, revocation, and recovery

Enrollment is an explicit authenticated ceremony that writes outside the repository. Scope revocation is a signed event and is distinct from signer/key revocation. For a planned key rotation, the operator first archives the old trust root and checkpoint, removes the device-bound representation at `~/Library/Application Support/Project/Approval/secure-enclave-p256-v1.key`, then runs `project approval enroll` again and re-signs every scope. There is no automatic key replacement or recovery from repository material. Loss of the device requires re-enrollment and fresh human review.

Version-1 single-attestation sidecars remain verifiable when no checkpoint exists. The first fresh approval or revocation replaces the legacy sidecar with a version-2 sequence-one history and creates the external checkpoint. Once checkpointed, restoring the legacy sidecar fails as replay. Copying history to a different repository, policy, scope, content set, signer, or checkpoint fails.
