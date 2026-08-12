# project-hostd

`project-hostd` is an optional outbound-only host telemetry agent. Project development and
workspace runtimes do not depend on it.

The agent reads a root- or service-owned `0600` JSON configuration, measures host resources,
reloads and attributes usage only to explicitly registered process-group boundaries, and sends a strict v1
message to Project Space. It has no listener and no command, shell, Git, repository, Codex,
dev-server, or arbitrary filesystem API.

The configuration contains `schemaVersion`, `deviceId`, `environmentId`, optional `hostId`,
`endpoint`, `token`, an absolute `statePath`, optional `intervalSeconds`, and an optional
`runtimes` list containing `workspaceId`, `generation`, `processGroupId`,
`processGroupLeaderPid`, and `processGroupLeaderStartedAtSeconds`. The leader PID plus kernel start
time prevents a recycled process-group number from being attributed to an earlier runtime. The state file
contains only sequence/retry data; it never contains the credential.

## Measurement contract

- CPU usage is a short two-sample system-counter reading and is expected to be within five
  percentage points of a simultaneous reading from the same operating-system counter.
- RAM and the largest local filesystem are reported in bytes. Totals must match the direct host
  counter within one percent; available values may differ by up to ten percent while the host is
  active because caches and filesystem reservations move between samples.
- A registered process group is sampled from the exact kernel process-group identity. Its summed
  memory and CPU are expected to be within ten percent of an immediately adjacent direct sample.
- GPU is optional. Unsupported GPU telemetry is omitted rather than guessed.
- The current runtime adapter measures Unix process groups. Other registered boundary kinds are
  not silently adopted and require a separately tested adapter.

Run one observation for installation validation:

```sh
project-hostd /etc/project-space/hostd.json --once
```
