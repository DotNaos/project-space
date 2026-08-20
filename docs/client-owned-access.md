# Client-owned Environment access

Project Space treats SSH as a client capability, not a server transport.
Compute may return a fresh, authorized Tailscale route with the exact `100.x`
address, SSH port and user, a pinned `SHA256:` host-key fingerprint, and an
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
normal local `ssh` process with a temporary pinned `known_hosts` file. The
temporary file is removed after exit. Credentials and terminal bytes remain in
the local SSH process.

The browser Compute detail view copies this exact-ID command. It does not send
an SSH request, open a server socket, or ask Project Space to relay a session.
Provider-native access, including GitHub Codespaces, remains behind its provider
adapter and is not converted into generic SSH.

## Failure contract

Every blocked path identifies its phase: `local_client`, `tailnet`, `target`,
`ssh`, `host_key`, or `codex`. The stable codes are
`local_client_unavailable`, `tailnet_unavailable`, `target_unavailable`,
`ssh_unavailable`, `host_key_mismatch`, `authentication_failed`, and
`codex_unavailable`. A stale, unverified, policy-blocked, ambiguous, or
cross-account route is blocked before any local SSH process starts.

The Codex phase is reserved for #726's client-owned discovery/runtime bridge;
it must consume the same target identity and local transport boundary rather
than introducing a server-side SSH fallback.

## Assumed dispatch/runtime contract

This work was developed against the #763 candidate
`9b952664fc6c4d519b15cea168157f513469d8a9`. The assumed contract is that
dispatch/runtime operations retain exact Environment identity, machine/workspace
ownership, and explicit unavailable/uncertain outcomes. This issue does not call
the #763 start endpoint and does not depend on its server-side relay behavior.

Before this branch is merge-ready, reconcile this document and the shared
`client-owned-access-api.ts` types against the exact #763 revision that lands:
the final dispatch payload must preserve the Environment identity fence and
must not turn an unavailable client-owned route into a server-originated SSH or
Codex session.

## Validation matrix

| Case | Required result | Evidence |
| --- | --- | --- |
| Local client has Tailscale online and target route is fresh | Local interactive SSH starts with direct `100.x` target | `internal/clientaccess` allowed-path test |
| Client has no local Tailscale route | Block before key scan or SSH | non-tailnet test |
| Target evidence is stale/unverified or route is non-Tailscale | Block before local execution | target/CLI tests |
| Current target key differs from pinned identity | Block before SSH | host-key mismatch test |
| SSH reports authentication failure | Return `authentication_failed` | classification test |
| SSH reports route failure | Return `target_unavailable` | classification test |
| Server inventory response | Contains launch metadata only; no credentials or raw identity keys | compute inventory privacy test |
