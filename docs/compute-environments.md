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
│       └── Connector installation(s)
└── Environment                       provider-managed host is hidden
    └── Connector installation(s)
```

The words in this hierarchy are not interchangeable. The historical
`MachineRecord` wire contract identifies one connector installation. It remains
available during migration, but it is not evidence for a physical device or an
environment.

## Glossary

### Platform

A Platform groups environments by their management and allocation source. It
can represent Local devices, GitHub Codespaces, a cloud sandbox provider,
Kubernetes, or a virtualization platform. A Platform can report provider quota
and environment lifecycle, but is not an execution target.

### Host

A Host is an optional, user-recognizable physical or virtual device whose
identity and total hardware capacity are known. A Host can exist with no
environment and no connector. It owns host-wide capabilities such as Wake-on-
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
scheduling capabilities. It can exist before any connector enrolls.

### Connector installation

A Connector installation is one authenticated transport/runtime installed in
exactly one Environment. Development and stable connector channels in the same
macOS Environment are two connectors, not two Environments. A persisted
connector cannot be unassigned and cannot move between Environments without
revoke and re-enroll.

The existing connector and machine-task v1 APIs continue using `machineId` for
the connector installation during migration. New code must not silently treat
that ID as a Host or Environment ID.

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
        ├── Connector: stable
        └── Connector: development
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
        └── Connector installation
```

The identity level must match the intended lifecycle. A long-lived namespace
allocation can parent disposable Pods. Provider/cluster/workload identity is
derived before enrollment; Pod names alone are display metadata.

## Identity and privacy boundary

Host, Environment, and Connector identities are independent:

```text
hostKey          stable hardware/provider-derived Host identity
environmentKey   stable OS/runtime/provider-derived Environment identity
connectorId      unique installation credential identity
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
silently reassigns an Environment or Connector.

## Registration transaction and impossible states

Enrollment requests are not Connector installations:

1. a client creates an enrollment request and public key;
2. a provider, host broker, deterministic resolver, or explicit user action
   resolves or creates the exact Environment;
3. one transaction persists both the connector credential and its immutable
   Environment association;
4. only then can the Connector become active.

The persistence slice must enforce `connector.environment_id NOT NULL`, unique
versioned Host and Environment identities within account/Platform scope, and an
immutable Connector-to-Environment association. The shared Slice 1 contract
already makes `environmentId` required and validates that it references an
existing Environment. It also rejects duplicate connector IDs, duplicate
derived identities, missing Platforms/Hosts/parents, and cross-Platform or
cross-Host nesting.

An unmanaged nested container with no trusted claim remains an enrollment
request. It must not become an unassigned connector or create duplicate
inventory.

## Resources and aggregation

Resource ownership follows the hierarchy:

- Host: physical capacity and hardware capabilities.
- Environment: effective allocation, limit, usage, and scheduling capacity.
- Connector: reports a Resource Profile; it does not own capacity.
- Task: consumes resources inside exactly one Environment.

Every Resource Profile includes its source and `reportedAt` freshness. A
connector report, provider report, and configured limit are distinguishable;
stale data must stay visibly stale rather than being presented as current.

Environment resource modes define aggregation:

- `dedicated`: independently allocated provider capacity can be counted once;
- `shared`: capacity shares a Host or parent Environment and is not additive;
- `exclusive`: mutually exclusive environments, such as dual boot, use the
  common Host capacity and are not additive.

Multiple connectors inside one Environment always share the same capacity
owner. Host-backed nested Environments collapse to their Host for capacity
summaries. Hostless, dedicated Codespaces or sandboxes remain independent.

## Task targeting

The canonical target is an Environment. Scheduling first authorizes the exact
Environment, then resolves one currently eligible Connector installation under
it. Connector selection can consider channel, capabilities, version, health,
and current leases without changing Environment identity.

During staged migration, machine-task API v1 continues targeting its historical
connector `machineId`. A future versioned Environment target is additive; the
meaning of an existing ID must never change in place.

## Compatibility and migration

This model is not a rename of `physical_machines`:

- `MachineRecord` and `PhysicalMachineRecord` stay available for existing
  storage, UI, connector, and machine-task v1 consumers.
- Legacy physical-machine groups become reconciliation input, not trusted Host
  or Environment evidence.
- Existing connector names and memberships cannot determine whether two
  installations share an Environment or whether Linux represents WSL, native
  Linux, Docker, or a cloud sandbox.
- A reconciliation flow must show the proposed Platform/Host/Environment tree
  and require confirmation wherever deterministic evidence is absent.
- Compatibility tables, routes, and aliases can be removed only after every
  consumer uses the new model and every persisted connector has an Environment.

Delivery is staged: shared contracts and rules first, then transactional
persistence/enrollment, connector identity adapters, inventory/reconciliation
UI, and finally Environment-targeted scheduling.
