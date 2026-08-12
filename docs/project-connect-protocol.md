---
title: Project Connect Protocol
description: Backend-mediated user approval and machine enrollment for the Project CLI.
---

# Project Connect Protocol

`project connect` enrolls one local machine with the hosted Project Space backend. The CLI never
loads Clerk configuration, calls Clerk, or stores a Clerk session. Project Space owns browser
authentication and turns an authenticated browser approval into a separate, revocable machine
identity.

The first release has one compiled-in production origin:

```text
https://projects.os-home.net
```

Tests and development builds inject an isolated loopback origin. Arbitrary remote origins are not
accepted by the first production command.

## Proven states

```text
CheckingBackend
  -> WaitingForApproval
  -> Approved
  -> ExchangingMachineProof
  -> Registered
```

Terminal states are `Denied`, `Expired`, `Revoked`, and `Blocked(reason)`.

The CLI may print `Registered` only after all of these facts have evidence:

```text
Registered
=> browser user was authenticated by Project Space
=> one-time request was approved
=> local Ed25519 private-key possession was proven
=> machine credential was issued
```

Registration does not claim that a permanent machine channel is online. Runtime control sessions
are launched separately through the canonical Environment flow when work is requested.

## Enrollment exchange

### 1. Create request

The CLI loads its existing Ed25519 identity key, or creates and stores one on the first successful
backend contact. It sends only the public key:

```http
POST /api/machine-connections
Content-Type: application/json

{
  "architecture": "amd64",
  "clientVersion": "0.3.0",
  "hostname": "os-pc",
  "name": "os-pc-wsl",
  "operatingSystem": "linux",
  "publicKey": "<base64url Ed25519 public key>"
}
```

The backend returns a random request ID, a separate 256-bit polling secret, an approval URL,
expiry, and polling interval. Only a hash of the polling secret is persisted. The secret is never
printed or put in the approval URL.

### 2. Browser approval

The CLI opens the returned same-origin approval URL. On a headless machine it prints the URL for
the user to open elsewhere. The Project Space browser obtains its normal Clerk-backed bearer token
and uses that token when reading or deciding the request.

```http
POST /api/machine-connections/{requestId}/approve
Authorization: Bearer <Project Space browser session>
```

The backend records the authenticated Project Space user and creates a random approval challenge.
The CLI never sees the browser or Clerk token.

### 3. Private polling

```http
GET /api/machine-connections/{requestId}
Authorization: Bearer <polling secret>
```

The request ID alone reveals no state. An approved response contains the random approval challenge.

### 4. Machine-key proof and exchange

The CLI signs these exact UTF-8 bytes:

```text
project-space-machine-connect:v1:{requestId}:{approvalChallenge}
```

It sends the base64url Ed25519 signature while authenticating with the polling secret:

```http
POST /api/machine-connections/{requestId}/exchange
Authorization: Bearer <polling secret>
Content-Type: application/json

{"signature":"<base64url signature>"}
```

The backend atomically consumes the approval, finds or creates the machine by its stable public key
and owner, and returns a newly rotated machine credential. Concurrent exchanges of one approval
have exactly one winner. Re-enrolling the same key for the same owner preserves the machine ID; a
different owner cannot claim that key. Only a hash of the machine credential is stored server-side.

## Registration status

```http
GET /api/machines/{machineId}/connection
Authorization: Bearer <machine credential>
```

This endpoint returns the server-side state of the registered machine credential. `project connect`
does not start or wait for a permanent background process.

Self-revocation is authenticated with the same machine credential:

```http
POST /api/machines/{machineId}/revoke
Authorization: Bearer <machine credential>
```

Browser-side owner revocation is a separate authenticated Project Space action. Revoking a machine
does not sign the user out or affect their other machines.

## Storage and failure rules

- The private Ed25519 key never leaves the enrolled machine.
- macOS uses the login Keychain. Native Windows stores the complete machine identity in a
  current-user DPAPI-protected file under LocalAppData so the same user can access it from desktop
  PowerShell and Windows OpenSSH. Windows never uses machine-wide DPAPI scope, and neither platform
  silently falls back to plaintext storage.
- Headless Linux and WSL use `~/.config/project-space/machine-credential.json` with a `0700`
  directory, a `0600` file, atomic replacement, a bounded state size, and a cross-process lock.
- Registration never installs or starts a LaunchAgent, systemd unit, Windows Scheduled Task, WSL
  supervisor, or other permanent Connector process.
- Revocation deletes the local runtime credential but retains the identity key so a later approved
  connection rotates access onto the same machine ID.
- Credentials never appear in command arguments, approval URLs, logs, shell history, or tracked
  files.
- Connection requests expire after ten minutes and are single-use.
- First-time setup installs no background service.
- Re-running `project connect` first validates the existing credential and reuses the same machine.
- Hosted production fails closed when its database-backed machine authentication is unavailable;
  it never downgrades to a shared connector token.
