# SSH control gateway provisioning

The SSH control route is intentionally separate from interactive SSH. Each route needs one unique
key reference with the `project_control_gateway_v1` purpose. That reference must not be shared with
another Environment or an interactive-shell route.

On the target, install the public key for a dedicated account with an OpenSSH forced command. The
authorized-key entry must include all of these restrictions:

```text
restrict,command="/usr/local/bin/project control-gateway --stdio" ssh-ed25519 <dedicated-public-key>
```

Do not add the same public key without the forced command. The server-side restriction is the
security boundary if key material is ever used outside Project Space.

Install the exact Environment identity as root after the inventory record is approved:

```sh
sudo /usr/local/bin/project control-gateway install-identity \
  --environment-id <environment-instance-uuid> \
  --target-identity-revision <inventory-identity-revision>
```

The command writes `/etc/project-space/environment-identity.json` atomically. It is idempotent for
the same identity and refuses a different identity unless `--replace` is supplied. The remote status
operation fails closed if the file is missing, writable by group or others, not root-owned, or does
not exactly match both the requested Environment UUID and identity revision.

The Project Space server also requires `PROJECT_SPACE_SSH_CONTROL_GATEWAY_ID`. That value must be
listed in the route's approved gateway IDs. The status API accepts only authenticated Project
machines, and the SSH command exposes only `status.v1`; it never accepts shell text.
