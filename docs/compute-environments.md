---
title: Compute Platforms, Hosts, and Environments
description: Canonical identity, inventory, resource, and execution-target model for Project Space.
---

# Compute Platforms, Hosts, and Environments

Project Space models compute with four different identities:

```text
Platform
├── Host?                              optional
│   └── Environment
│       └── Workspace Runtime generation(s)
└── Environment                       provider-managed host is hidden
    └── Workspace Runtime generation(s)
```

The words in this hierarchy are not interchangeable. The historical
`MachineRecord` wire contract identifies retired transport evidence. It remains
available only for compatibility and cleanup; it is not evidence for a physical
device, an Environment, or an execution target.

## Glossary

### Platform

A Platform groups environments by their management and allocation source. It
can represent Local devices, GitHub Codespaces, a cloud sandbox provider,
Kubernetes, or a virtualization platform. A Platform can report provider quota
and environment lifecycle, but is not an execution target.

### Host

A Host is an optional, user-recognizable physical or virtual device whose
identity and total hardware capacity are known. A Host can exist with no
Environment or Runtime. It owns host-wide capabilities such as Wake-on-
LAN, JetKVM, physical CPU, memory, GPU, and storage.

Provider-managed compute does not fabricate a Host when the provider hides the
underlying device. In that case the Environment's host association is
`not_applicable` and the UI says **Provider managed**.

### Environment

An Environment is the concrete execution and task-scheduling target. Native
macOS, Windows, Linux, WSL distributions, Docker containers, devboxes,
Codespaces, cloud sandboxes, virtual machines, and Kubernetes workloads are
Environments. An Environment belongs to exactly one Platform, can optionally
belong to one Host, and can contain nested Environments.

An Environment owns its effective allocation, limits, usage, lifecycle, and
scheduling capabilities. It can exist before any Workspace Runtime starts.

### Retired Connector record

A Connector record is historical transport evidence associated with one
Environment. It is not an execution target and must not be installed, enrolled,
started, or used to select work. New execution uses a generation-scoped
Workspace Runtime instead.

Historical records and stored v1 results may still contain a `machineId` that
identified a Connector installation. New requests cannot select that identity,
and no code may silently treat it as a Host or Environment ID.

### Runner Host and Runner Workspace

A Runner Host is a service that provisions or supervises execution capacity. It
may correspond to a Platform provider, a Host service, or an Environment-local
agent, but is not a Host record by definition.

A Runner Workspace is the isolated checkout and task state created for one
agent run. A Git worktree, devcontainer, or disposable sandbox directory can be
a Runner Workspace. The workspace runs inside one Environment; it does not
replace that Environment's identity.

## Examples

### Native devices and dual boot

```text
Platform: Local devices
└── Host: Desktop PC                 Verified · smbios
    ├── Environment: Windows         exclusive
    │   └── Environment: WSL Ubuntu shared
    │       └── Environment: devbox shared
    └── Environment: Ubuntu native   exclusive
```

Windows and native Ubuntu have different environment keys but the same host
key. They are mutually exclusive boot environments. Inventory and capacity
summaries use the Host once and never add the same physical RAM or CPU twice.

Three laptops, a desktop, macOS, Windows, native Ubuntu, and WSL therefore map
to user-recognizable Hosts with separate native and nested Environments. Dual
boot changes the active Environment, not the Host.

### Docker and devboxes

```text
Host: MacBook
└── Environment: macOS
    └── Environment: Docker devbox
        └── Workspace Runtime generations
```

A trusted host broker or provisioner supplies the container's derived
environment identity and parent claim. A disposable container cannot invent a
Host association from hostname, container ID, IP address, or MAC address. A
managed recreation can reuse an identity persisted outside the container; a
new sandbox receives a new identity.

### GitHub Codespaces and cloud sandboxes

```text
Platform: GitHub Codespaces
├── Environment: project-space / issue-454   Provider managed
└── Environment: inventory / issue-82        Provider managed

Platform: Cloud sandboxes
└── Environment: sandbox-019f...             Provider managed
```

The verified provider identity creates one Environment per Codespace or
sandbox. All GitHub Codespaces share the Platform layer, but they do not share a
fictional physical Host.

### Kubernetes

```text
Platform: Kubernetes
└── Environment: cluster/namespace allocation
    └── Environment: workload or development Pod
        └── Workspace Runtime generations
```

The identity level must match the intended lifecycle. A long-lived namespace
allocation can parent disposable Pods. Provider/cluster/workload identity is
derived before enrollment; Pod names alone are display metadata.

## Identity and privacy boundary

Host, Environment, and Workspace Runtime identities are independent:

```text
hostKey          stable hardware/provider-derived Host identity
environmentKey   stable OS/runtime/provider-derived Environment identity
workspaceId      stable managed checkout identity
generation       one exact Workspace Runtime lifecycle
```

`DerivedIdentityKey` contains only an account-scoped, application-specific,
versioned derivative. Raw TPM, SMBIOS, OS installation, Codespace, cloud, or
cluster identifiers never cross the device/provider trust boundary and are not
persisted by Project Space.

Host evidence is evaluated in this order:

1. provider-attested Host identity;
2. TPM-backed identity;
3. normalized, valid SMBIOS/System UUID;
4. a trusted host-broker claim for nested Environments;
5. explicit user assignment.

Hostname, display name, IP address, MAC address, model, connector channel, SSH
user, and mutable container ID are never automatic merge keys. Suggestions can
use mutable metadata, but only as non-mutating hints.

Identity claims resolve by exact `(version, derived key)`. Repeated equal claims
are idempotent. Multiple different trustworthy claims produce `conflict`; an
absence of trustworthy claims produces `unresolved`. Neither case guesses.

## Host association truth

Every Environment carries one explicit association state:

| State | Evidence | UI label | Meaning |
| --- | --- | --- | --- |
| `verified` | provider, TPM, SMBIOS, or host broker | Verified · evidence | Deterministic evidence resolved the Host. |
| `manual` | user | Manually assigned | A user asserted the Host; hardware has not verified it. |
| `unresolved` | none | Needs assignment | No reliable Host association exists. |
| `conflict` | contradictory evidence | Conflict · review required | New evidence disagrees; do not move silently. |
| `not_applicable` | provider or none | Provider managed | The provider intentionally hides the Host. |

Reliable later evidence may upgrade `manual` to `verified`. Contradiction never
silently reassigns an Environment or Workspace Runtime.

## Runtime bootstrap and impossible states

Environment bootstrap resolves or creates the exact Environment before it can
launch a Workspace Runtime:

1. the caller selects one exact Environment Instance;
2. the control boundary verifies the Workspace, owner, commit, manifest digest,
   and requested generation;
3. one Runtime generation is started or reused only when every binding matches;
4. mismatched, stale, or legacy Connector input is rejected rather than
   reinterpreted.

Historical connector tables and machine records remain available only for
read-only migration evidence and exact cleanup. They cannot create a new
permanent process or select execution.

## Resources and aggregation

Resource ownership follows the hierarchy:

- Host: physical capacity and hardware capabilities.
- Environment: effective allocation, limit, usage, and scheduling capacity.
- Runtime or host telemetry source: reports a Resource Profile; it does not own capacity.
- Task: consumes resources inside exactly one Environment.

Every Resource Profile includes its source and `reportedAt` freshness. A
runtime report, host report, provider report, and configured limit are distinguishable;
stale data must stay visibly stale rather than being presented as current.

Environment resource modes define aggregation:

- `dedicated`: independently allocated provider capacity can be counted once;
- `shared`: capacity shares a Host or parent Environment and is not additive;
- `exclusive`: mutually exclusive environments, such as dual boot, use the
  common Host capacity and are not additive.

Multiple Runtime generations inside one Environment always share the same
capacity owner. Host-backed nested Environments collapse to their Host for capacity
summaries. Hostless, dedicated Codespaces or sandboxes remain independent.

## Task targeting

The canonical target is an Environment. Scheduling authorizes the exact
Environment and then launches or resumes one exact Workspace Runtime
generation. Runtime selection is bound to the Workspace, manifest, generation,
capabilities, health, and current lease; no Connector ID is accepted as a
substitute.

Historical machine-task v1 records retain their original physical-machine and
Connector selectors as immutable evidence. New requests use `environmentId`
and an eligible Workspace Runtime; old selectors fail predictably and are not
translated into a canonical target.

## Compatibility and migration

This model is not a rename of `physical_machines`:

- `MachineRecord` and `PhysicalMachineRecord` stay available for compatibility
  consumers while the Settings inventory uses `computeInventory`.
- Legacy physical-machine groups become reconciliation input, not trusted Host
  or Environment evidence.
- Existing connector names and memberships cannot determine whether two
  installations share an Environment or whether Linux represents WSL, native
  Linux, Docker, or a cloud sandbox.
- Manual physical-machine grouping is reconciliation input. It produces a
  visible **Manually assigned** Host association; deterministic connector
  evidence produces **Verified**, missing evidence produces **Needs
  assignment**, and provider-managed sandboxes produce **Provider managed**.
- Compatibility tables, routes, and aliases remain read-only cleanup/migration
  input; they never create a new permanent Connector installation.

The migration is additive and rollback-safe: legacy tables and routes are not
dropped. Every existing membership is backfilled to one conservative
Environment; new Workspace Runtimes progressively enrich identity, platform
kind, and resources through the canonical bootstrap flow.

## Runtime detection and rollout

Environment bootstrap reports an application-specific derivative, never the raw input:

- GitHub Codespaces: `CODESPACES` plus a locally hashed Codespace identity;
- Kubernetes: cluster/runtime presence plus a locally hashed workload identity;
- WSL: typed distro Environment plus best-effort SMBIOS Host evidence;
- Docker: typed container Environment with no invented Host;
- native macOS, Windows, and Linux: native Environment plus best-effort Host
  evidence.

The server derives the persisted identity again with the account ID, so the
stored key is account-scoped. CPU, memory, filesystem, architecture, source,
and report time are included in `ResourceProfile`. Host-backed profiles are
stored once at Host level; provider-managed capacity stays on the Environment.

Old Connector records are conservative compatibility evidence until an owner
removes them through the dependency-checked cleanup flow. A removal receipt
suppresses only that exact legacy projection, so later inventory refreshes do
not recreate it. The historical membership remains available for audit; no
canonical Environment, Host, Tailscale device, provider resource, credential,
or remote machine is deleted as part of Compute cleanup.
