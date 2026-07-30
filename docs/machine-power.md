# Managed machine power

Project Space exposes one authenticated backend operation to both the Project
CLI and product clients:

```text
project machine power status --machine os-pc
project machine power on --machine os-pc
project machine power off --machine os-pc
```

Use `--format json` for automation. By default, `on` waits up to one minute for
fresh JetKVM physical-power evidence. `--no-wait` returns after the single
delivery attempt and does not claim broker receipt or that the machine is
online.

The result states keep dispatch and proof separate:

- `accepted`: a future provider may prove broker receipt without proving
  physical state. JetKVM's QoS 0 toggle does not currently produce this state.
- `confirmed-online` / `confirmed-offline`: fresh provider evidence confirms it.
- `unsupported`: the exact machine has no supported operation.
- `failed`: the provider rejected the request before dispatch.
- `uncertain`: delivery or the resulting physical state cannot be proven.

## Safety boundary

The JetKVM provider may publish only one short ATX press. Before it does so,
Project Space requires a fresh MQTT heartbeat, the approved JetKVM firmware
version, an immutable account and physical-machine ID binding, and physical
evidence that the machine is off. The operation is durably reserved before
publish and fenced per machine. A QoS 0 publish is reported as `uncertain`
because it has no broker acknowledgement, and it is never automatically
retried. Fresh online evidence reconciles the operation and releases the fence;
a five-minute safety window prevents a crashed request from blocking forever.
The durable audit records whether the request came from a signed-in human or
from an exact authenticated connector, without storing its credential.

Forced power-off is not enabled. The `off` command currently returns
`unsupported`; use the managed operating-system or SSH shutdown path. A long
press, reset, JetKVM reboot, update, virtual media, and DC power are excluded by
the broker ACL.

## Stored JetKVM configuration

Each device has a versioned, non-secret desired configuration in
`config/machine-power/<machine>.json`. It records the exact machine/device
binding (owner ID and immutable physical-machine ID), firmware compatibility,
broker endpoint, device-derived topic namespace and separate device/provider
identities, TLS requirements, allowed actions, and the device's 1Password
references. Provider secret references live in the deployment manifest rather
than in a user-selectable binding. Passwords remain in 1Password and are
injected only into the server or the one-time device setup.

The same binding stores the non-secret provisioning contract: expected
JetKVM hostname, Ethernet MAC, SSH host-key fingerprint, pinned JetKVM
application hash, pinned Tailscale version and hostname, Tailnet tag, and
1Password references for the dedicated SSH and Tailscale credentials. Check or
apply it with:

```text
bun run jetkvm:provision --machine os-pc --format json
bun run jetkvm:provision --machine os-pc --apply --format json
```

The default command is read-only and exits with status 2 when it detects
drift. `--apply` validates the exact device before changing anything, verifies
the official Tailscale package checksum, uses a one-use ten-minute auth key,
updates only JetKVM's `mqtt_config` object through an atomic replacement,
keeps a content-addressed root-only backup on the device, restores it after a
failed readiness check when SSH remains available, and verifies the final
state. A second run must report `changes: []`.

`bun run machine-power:mqtt-acl:generate` renders the broker ACL from all
bindings. Every Project Space provider identity and every JetKVM identity gets
only the four exact topics required for that one device. No cross-device
wildcard is granted. The check command fails when a changed binding has not
been reflected in the ACL.

The current broker DNS name resolves to the VPS Tailscale address. The Tailnet
policy gives `tag:jetkvm` access only to `project-space-vps` on TCP 443. The
dedicated OAuth credential can create one-use auth keys only for that exact
tag. A public DNS route is a different security boundary and requires an
explicit deployment decision.

JetKVM 0.5.8 still has no supported headless API for applying MQTT settings.
Its configuration RPC is available only through the browser's WebRTC session.
The provisioner therefore uses JetKVM's supported SSH/Tailscale installation
path, then performs one version-pinned and identity-guarded replacement of the
`mqtt_config` subtree. It never copies a whole configuration between devices
because that file also contains device-specific authentication and cloud
secrets. After a factory reset of the same device, the only unavoidable
bootstrap is enabling Developer Mode and adding the stored SSH public key once.
A replacement device must also be deliberately enrolled: verify and store its
new device ID, MAC address, SSH host key and firmware pin, create separate
least-privilege broker identities, and regenerate the ACL. This enrollment
updates the non-secret contract; it does not require manually re-entering
Tailscale or MQTT settings in the browser. The repository command owns those
settings after SSH becomes available. Re-review the application hash and config
format before accepting new JetKVM firmware.

If multiple owners use the same human machine selector, provisioning fails
until the operator also supplies the immutable physical machine ID. The
expected Tailnet tag must be the device's only tag before MQTT credentials are
written.

## Shared self-hosted broker

The standalone Mosquitto service in `deploy/mqtt` is intentionally separate
from the Project Space application. Future applications, including a Matter
bridge, should get their own username and topic namespace with a separate ACL.
They must not reuse Project Space or JetKVM credentials.

For multiple Project Space users, machine lookup, provider binding, durable
operations, and broker credentials all remain scoped to the exact owner and
physical machine. A generic machine membership does not grant physical power.
Shared power control requires a future explicit machine-scoped power grant;
it must not be inferred from ordinary project or connector access.
