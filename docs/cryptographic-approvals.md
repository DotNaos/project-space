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

Paths are repository-relative. Symlinks and paths escaping the repository are rejected. Files are hashed individually in sorted slash-normalized order. The signed canonical JSON payload binds the schema version, repository identity, policy identity and digest, stable scope identity, complete file list and hashes, content digest, signer fingerprint, and issue time. The signature is DER-encoded ECDSA P-256 over SHA-256 of that canonical JSON. Sidecars contain no unsigned approval boolean.

Policy changes intentionally require a new external enrollment: the external trust root pins the canonical policy digest. This prevents an agent from deleting scopes or weakening ignores and then declaring success.

## Commands

```sh
project approval enroll --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json"
project approval status --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json"
project approval sign --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json" --scope button
project approval verify --root /path/to/repo --trust-root "$HOME/.config/project/trust/ui.json"
```

Enrollment and signing use the macOS Secure Enclave through the bundled `project-approval-signer` component. The Project CLI accepts only the adjacent Apple-signed DotNaos helper; no environment or repository path can replace it. The private key is non-exportable. CryptoKit stores only its device-bound opaque representation under the user's Application Support directory, and every signing operation uses a fresh LocalAuthentication context. An agent can request the system prompt but cannot complete it without the device owner. Socially inducing the owner to approve the wrong operation is outside the cryptographic guarantee.

Verification is pure Go and portable. Signing fails honestly on non-macOS systems or when the trusted signed helper is absent. `project validate` also verifies approvals when the default policy exists; it fails closed unless `PROJECT_APPROVAL_TRUST_ROOT` points at an external trust root.

## External fail-closed enforcement

A repository script, workflow, public key, or CLI binary built from the checkout is not trusted against an agent that can edit the checkout. The RL runner or CI administrator must own the gate outside the workspace:

```sh
/opt/project-trust/bin/project approval verify \
  --root "$UNTRUSTED_CHECKOUT" \
  --policy .project/approvals/policy.yaml \
  --trust-root /etc/project-trust/ui.json \
  --format json
```

The runner must make `/opt/project-trust/bin/project`, its expected code signature or artifact hash, `/etc/project-trust/ui.json`, and the invocation itself read-only to the repository agent. Removing repository validation scripts then cannot remove the external invocation. The external configuration pins repository ID, policy ID and digest, signer SPKI fingerprint, and the exact public key. Any missing policy, missing sidecar, replaced key, changed content, changed policy, malformed signature, or verifier error exits non-zero.

[`packaging/macos/trusted-approval-gate.sh`](../packaging/macos/trusted-approval-gate.sh) is the installable runner contract. An administrator copies it outside the checkout and pins both the preinstalled Project CLI hash and trust-root hash in runner-owned configuration. Running the copy in the repository is not trusted.

## UI and project-template integration

The UI repository can map Storybook component IDs to stable policy scope IDs. A development overlay may call `project approval status` and write unsigned review notes, but only `project approval sign` can create approval truth. Guard the overlay with a compile-time development condition and assert the production bundle contains neither its module nor approval controls.

`project-template` uses the identical policy schema. Its trusted validation environment sets `PROJECT_APPROVAL_TRUST_ROOT` and runs `project validate`; the adversarial gate still invokes the preinstalled verifier directly as shown above. Trust roots are never copied into generated repositories.

## Rotation, revocation, and recovery

Enrollment is an explicit authenticated ceremony that writes outside the repository. Rotation creates a new Secure Enclave key/trust root and requires every scope to be re-signed. Revocation removes the old fingerprint from the external runner configuration. There is no automatic key replacement or recovery from repository material. Loss of the device requires re-enrollment and fresh human review.

Identical content under the identical repository, policy, scope, and signer intentionally remains approved. Copying a sidecar to a different repository, policy, scope, content set, or signer fails.
