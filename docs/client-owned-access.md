# Client-owned Environment access

Project Space treats SSH as a client capability, not a server transport.
Compute may return a fresh, authorized Tailscale route with the exact canonical
`100.64.0.0/10` address, SSH port and user, a pinned `SHA256:` host-key
fingerprint, and an
opaque target identity revision. This metadata is enough for a local client to
launch SSH; it contains no credential reference, private key, agent socket,
command, terminal stream, or remote output.

## Boundary

The supported path is:

```text
Compute inventory → client-owned access descriptor → local Tailscale proof
→ local host-key probe → local ssh process → target Environment
```

`project ssh --environment-id <id>` loads the current authorized inventory,
selects one highest-priority fresh Tailscale SSH route, verifies that the local
Tailscale client is online, probes the exact address with `ssh-keyscan`, compares
the returned key fingerprint with the verified descriptor, and then starts the
normal local `ssh` process with `-F /dev/null`, disabled proxy options, a forced
PTY, and a temporary pinned `known_hosts` file. The temporary file is removed
on success, failure, cancellation, and interruption. Credentials and terminal
bytes remain in the local SSH process; the bridge never reconnects
automatically (`MaxReconnectAttempts = 0`).

The client-owned Workspace Runtime path uses the same target proof. `project
environment bootstrap <id> --client-owned` obtains a short-lived, typed Runtime
credential for the exact Environment, Host, Workspace, generation, and target
identity revision. It then sends one bounded `workspace-runtime.start.v1`
control frame directly over that pinned SSH connection. The server issues the
credential and records authorization, but it never opens or relays the SSH
connection. The target's installed control-gateway identity must include the
same Host binding; a missing or changed Host binding is rejected before the
runtime manager starts. A successful response is only accepted when it matches
the requested Environment, Host, Workspace, generation, commit, manifest,
operation, and identity revision. The Runtime then registers its
`runtime.codex.v1` session through the existing authenticated Runtime socket.

The browser Compute detail view displays this exact-ID command as informational
text. It does not claim overall SSH readiness, start a browser session, send an
SSH request, open a server socket, or ask Project Space to relay a session. It
states that the target is ready only after local Tailscale and SSH checks are
performed by the client. A callable browser-to-local bridge is tracked in #831.
Provider-native access, including GitHub Codespaces, remains behind its provider
adapter and is not converted into generic SSH.

## Failure contract

Every blocked path identifies its phase: `local_client`, `tailnet`, `target`,
`ssh`, `host_key`, or `codex`. The stable codes are
`local_client_unavailable`, `tailnet_unavailable`, `target_unavailable`,
`ssh_unavailable`, `host_key_mismatch`, `authentication_failed`, and
`codex_unavailable`. A stale, unverified, policy-blocked, ambiguous, or
cross-account route is blocked before any local SSH process starts.

The local session returns the underlying SSH exit status when one exists,
propagates cancellation as an SSH failure, uses a forced PTY for terminal
resize, and cleans up its temporary host-key file on every exit path. Reconnect
is bounded at zero automatic attempts so a fresh authorization and identity
check is required for another session.

Codex commands use the registered Workspace Runtime session after bootstrap.
They remain bound to the exact Environment, Workspace, generation, and online
`runtime.codex.v1` capability; there is no server-side SSH fallback.

## Assumed dispatch/runtime contract

The client-owned Runtime launch is a separate typed endpoint from the legacy
server-dispatched launch. It returns only the short-lived Runtime credential
and its exact binding; the local CLI owns the SSH transport. An unavailable or
stale route remains unavailable and cannot become a server-originated SSH or
Codex session.

## Validation matrix

| Case | Required result | Evidence |
| --- | --- | --- |
| Local client has Tailscale online and target route is fresh | Local interactive SSH starts with direct `100.x` target | `internal/clientaccess` allowed-path test |
| Client has no local Tailscale route | Block before key scan or SSH | non-tailnet test |
| Target evidence is stale/unverified or route is non-Tailscale | Block before local execution | target/CLI tests |
| Current target key differs from pinned identity | Block before SSH | host-key mismatch test |
| Exact Host or identity revision changes during launch | Block before credential issuance or control execution | client-launch binding and control-gateway tests |
| Client-owned Runtime control result changes Environment, Host, Workspace, or generation | Reject the result | exact-host bootstrap test |
| Runtime does not register online with `runtime.codex.v1` | Keep Codex unavailable | existing Runtime session registration boundary |
| SSH reports authentication failure | Return `authentication_failed` | classification test |
| SSH reports route failure | Return `target_unavailable` | classification test |
| Server inventory response | Contains launch metadata only; no credentials or raw identity keys | compute inventory privacy test |
