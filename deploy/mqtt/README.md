# Shared MQTT broker

This directory defines the standalone Mosquitto broker used by Project Space
machine-power providers. It is intentionally separate from the Project Space
application Compose stack so another application can use the broker later with
its own namespace and credentials.

The configured endpoint is `mqtt.os-home.net:443`. Its current DNS record
points to the VPS Tailscale address, so a JetKVM must itself be connected to
the Tailnet before MQTT is enabled. Traefik selects the MQTT TCP router by its
exact TLS server name, terminates TLS with a publicly trusted certificate, and
forwards MQTT to the broker only on the private Docker network. Port 1883 is
never published on the host.

Changing the DNS record to the VPS public address is a separate architecture
choice: it avoids installing Tailscale on each JetKVM, but exposes the
authenticated TLS listener to the public Internet. Do not silently switch
between these network paths.

Runtime-only files are not committed:

- `deploy/mqtt/config/password_file`
- `/opt/platform/state/mqtt/data`

Each JetKVM has two distinct broker identities: one device identity and one
Project Space provider identity. Both identities are restricted to the exact
device topic prefix. The provider may read JetKVM status, ATX state, and the
installed firmware version, and may write the short-press command only. It
cannot read or control another JetKVM. Long press, reset, reboot, firmware
installation, virtual-media, and DC-power commands are absent.

## JetKVM desired configuration

Project Space stores non-secret desired settings and the exact owner,
machine, device, topic, and provider-credential binding in
`config/machine-power/<machine>.json`. Broker passwords remain in 1Password.
The checked-in ACL is generated from those bindings:

```text
bun run machine-power:mqtt-acl:generate
bun run machine-power:mqtt-acl:check
```

Adding a binding therefore generates exact ACL blocks for only that device;
it never extends a shared wildcard credential. Add the corresponding distinct
device and Project Space provider credentials to 1Password and the broker
password file before enabling the device.

`update-password-client.sh` adds or rotates one exact device/provider identity
through an interactive password prompt. The companion Expect wrapper accepts
the password through a protected environment variable, suppresses terminal
logging, and sends it only to the remote prompt. Use it through `op run`; never
put the password in an argument, repository file, deployment log, or shell
history. `remove-password-client.sh` revokes one managed identity through the
same copy-update-replace flow. Both scripts reload the broker only after the
new password file is in place. Remove the corresponding generated ACL block
as well, and keep the revoked 1Password item until rollback is no longer
needed.

JetKVM 0.5.8 does not expose a supported headless API for applying MQTT
settings. Its existing JSON-RPC methods are transported through the browser's
WebRTC session. Project Space therefore keeps a versioned, non-secret
provisioning contract and applies it through the dedicated SSH key:

```text
bun run jetkvm:provision --machine os-pc
bun run jetkvm:provision --machine os-pc --apply
```

The command validates the device identity and pinned firmware first, follows
JetKVM's official checksum-verified Tailscale installation flow, joins the
Tailnet with a one-use `tag:jetkvm` auth key, and atomically changes only the
`mqtt_config` subtree with a content-addressed root-only backup and bounded
reboot/readiness checks. A failed readiness check restores that backup when SSH
remains available. It never copies
`/userdata/kvm_config.json` between devices. Browser automation, cookies, and
user-facing device credentials are not part of the provider or provisioner.

A factory reset of the same JetKVM still needs the minimum supported local
bootstrap: enable Developer Mode and add the 1Password-backed SSH public key.
A replacement device additionally needs deliberate enrollment of its new
identity pins and separate least-privilege MQTT identities before regenerating
the ACL. After SSH is available, the stored command applies Tailscale and MQTT
idempotently without browser automation. Until JetKVM offers a supported
service-token provisioning API, changing the pinned firmware or configuration
format must fail closed and receive an explicit review.
