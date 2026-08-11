---
title: Remote Development and Compute Control Architecture
description: Target architecture for compute discovery, environment catalogs and instances, SSH control, ephemeral worktree runtimes, optional host telemetry, and out-of-band console access.
---

# Remote Development and Compute Control Architecture

## Status

This document defines the **target architecture** for Project Space remote development and compute control. It is intentionally more forward-looking than the current connector implementation.

The current codebase still uses `Connector` and `ComputeEnvironmentRecord` concepts in several APIs. During migration:

- the current concrete `ComputeEnvironmentRecord` maps to the future **Environment Instance**;
- the current connector remains supported until SSH control and outbound runtime channels replace it;
- no existing connector identifier becomes a Host, Environment definition, or Environment Instance identifier by reinterpretation.

## Executive summary

Project Space should use the following model:

```text
Environment catalog
├── Windows
├── macOS
├── Ubuntu Linux
├── WSL Ubuntu
├── GitHub Codespace
└── Custom definitions

Compute inventory
└── Platform
    ├── Host?                                  optional
    │   ├── Host capabilities
    │   │   ├── power
    │   │   └── console: JetKVM
    │   └── Environment Instance
    │       ├── references one catalog Environment
    │       ├── private-network access routes
    │       └── Workspace / Worktree runtimes
    └── Environment Instance                  provider-managed, no visible Host
```

The core decisions are:

1. **Environment is a reusable catalog definition.** `Windows` is one definition that can have many concrete instances.
2. **Environment Instance is the concrete execution target.** `windows-01` and `windows-02` both reference `Windows`, but run on different Hosts.
3. **Platform and Host remain part of every concrete target path.** They are resolved from the selected Environment Instance rather than supplied independently for every command.
4. **SSH over a private network is the primary control channel.** Tailscale is the first provider; WireGuard and other private-network providers must fit the same abstraction.
5. **The persistent Go `project` CLI performs bootstrap and lifecycle actions.** It can be explicitly versioned and updated on Environment Instances.
6. **Project-specific tooling is worktree-scoped and ephemeral.** Codex, dependencies, dev servers, and task runtimes belong to the Workspace runtime, optionally inside a devcontainer.
7. **Runtimes report their own state outbound.** Dev servers and workspace supervisors send events and telemetry to Project Space instead of being polled continuously through SSH.
8. **The Codex App Server opens an outbound WebSocket.** Streaming, steering, queueing, and session state continue over that channel after SSH starts the runtime.
9. **`project-hostd` is a small optional Rust service.** Development must work without it. Its purpose is host-wide resource telemetry and narrowly scoped lifecycle assistance, not arbitrary shell execution.
10. **JetKVM is a Host console capability.** It supplies screen, keyboard, and mouse access even in BIOS, bootloaders, recovery environments, and installers.
11. **The current large Connector is removed from the target inventory model.** Access routes, runtime sessions, and optional host telemetry replace its responsibilities without creating multiple user-visible connectors per OS.

---

# 1. Motivation

The current Connector combines several unrelated responsibilities:

- persistent registration and status;
- project and worktree discovery;
- remote command execution;
- Git operations;
- Codex discovery and launch;
- dev-server lifecycle;
- Tailscale publication;
- resource reporting;
- version management.

That creates three problems.

First, the security boundary is unnecessarily large. A permanent service that can inspect repositories, run commands, control Codex, and manage networking must secure all of those operations together.

Second, installation identity becomes noisy. Multiple development and stable Connector installations can exist in one OS even though the user recognizes only one Windows or macOS installation.

Third, globally installed tooling drifts. Codex and project-specific dependencies can differ from what a particular repository or worktree expects.

The target architecture reduces the permanent footprint:

```text
Persistent on an Environment Instance
├── SSH server reachable only through a private network
├── project CLI                              small Go binary
└── project-hostd                            optional small Rust service

Ephemeral per Workspace / Worktree
├── runtime supervisor
├── repository-specific project tooling
├── exact Codex version
├── dependencies
├── dev servers
└── Codex App Server
```

---

# 2. Domain model

## 2.1 Platform

A **Platform** is a configured source and lifecycle boundary for compute capacity.

Examples:

- Local devices;
- GitHub Codespaces;
- cloud sandboxes;
- Kubernetes;
- a virtualization cluster;
- another provider integration.

A Platform can provide:

- discovery;
- provisioning and deletion;
- start and stop operations;
- quotas;
- provider-native access routes;
- provider-attested identity.

A Platform is not itself an execution target.

A Platform record is concrete. For example, `GitHub Codespaces · DotNaos` may represent one configured provider account, while `Local devices` represents the user's local inventory.

## 2.2 Environment catalog definition

An **Environment** is a reusable catalog definition. It describes what kind of operating system or runtime an instance represents, but it does not represent one running installation.

Examples:

```text
windows
macos
ubuntu
wsl-ubuntu
github-codespace
cloud-sandbox
custom-gpu-linux
```

A definition may contain:

- stable catalog ID and slug;
- display name;
- environment kind;
- operating-system family;
- optional version or version range;
- supported architectures;
- expected bootstrap strategy;
- expected capabilities;
- default workspace runtime policy;
- provider constraints;
- built-in or user-defined ownership.

A catalog Environment does **not** contain:

- current CPU or memory usage;
- an SSH address;
- a Host association;
- an online state;
- running Workspaces;
- an installed Connector or daemon identity.

Those properties belong to an Environment Instance.

## 2.3 Environment Instance

An **Environment Instance** is one concrete installed or provisioned realization of an Environment definition. It is the canonical scheduling and remote-control target.

Example:

```text
Environment definition: Windows
├── Environment Instance: windows-01
│   ├── Platform: Local devices
│   └── Host: os-pc
└── Environment Instance: windows-02
    ├── Platform: Local devices
    └── Host: os-work-2
```

Both instances are Windows, but they have independent:

- identities;
- lifecycle state;
- Host association;
- private-network addresses;
- SSH host keys and users;
- effective resources;
- running Workspaces;
- access capabilities;
- telemetry freshness.

An Environment Instance belongs to exactly one Platform and may belong to one Host. It may also have a parent Environment Instance.

Examples of nesting:

```text
windows-01
└── wsl-ubuntu-01
    └── persistent-devbox-01
```

A container or devcontainer should only become an Environment Instance when it is an independently inventoried, schedulable allocation. A short-lived devcontainer created solely for one Worktree is normally a **Workspace Runtime**, not a top-level inventory Environment Instance.

## 2.4 Host

A **Host** is an explicitly recognizable physical or virtual device whose overall capacity and host-wide capabilities matter.

Examples:

```text
os-pc
os-macbook
os-work-1
server-1
```

A Host belongs to one Platform and can contain zero or more Environment Instances.

Host-owned properties include:

- physical CPU, memory, GPU, and storage capacity;
- power capabilities such as Wake-on-LAN;
- out-of-band console capabilities such as JetKVM;
- stable hardware identity evidence;
- mutually exclusive boot environments.

Dual boot is represented as one Host with multiple Environment Instances:

```text
Platform: Local devices
└── Host: os-pc
    ├── Environment Instance: windows-01
    └── Environment Instance: ubuntu-native-01
```

Only one may be active at a time, but both remain known inventory objects.

Provider-managed compute does not fabricate a Host when the provider hides it. A GitHub Codespace therefore has a Platform and an Environment Instance, but no Project Space Host.

## 2.5 Workspace / Worktree

A **Workspace** is the isolated project checkout and task state used for development. A Git worktree is the normal local implementation.

```text
Environment Instance: wsl-ubuntu-01
└── Workspace: project-space / issue-454
    ├── repository checkout
    ├── branch and worktree metadata
    ├── runtime manifest
    └── ephemeral runtime
```

The Workspace belongs to exactly one Environment Instance while active. It may later be moved or recreated elsewhere, but that is a deliberate lifecycle operation rather than an identity mutation.

## 2.6 Workspace Runtime

A **Workspace Runtime** is the ephemeral process or container group created for one Workspace.

It can contain:

- exact Codex version;
- repository-specific Project tooling;
- language toolchains and dependencies;
- dev servers;
- Codex App Server;
- runtime supervisor;
- log and telemetry exporters.

Implementations may include:

- devcontainer;
- Docker/Podman container;
- tmux-managed host processes;
- process groups;
- systemd transient units;
- Windows Job Objects;
- provider-native workspace processes.

Deleting or rebuilding the Workspace Runtime removes its tooling without modifying the base Environment Instance.

## 2.7 Runtime Session

A **Runtime Session** is one live, authenticated connection from a Workspace Runtime to Project Space.

It is ephemeral and contains:

- session ID;
- Workspace ID;
- Environment Instance ID;
- runtime version;
- connection and heartbeat state;
- current ports and dev-server URLs;
- Codex App Server state;
- scoped capabilities.

Runtime Sessions are not inventory objects and do not replace Environment Instance identity.

## 2.8 Private Network

A **Private Network** represents a secure network boundary through which access routes are reachable.

Initial provider:

- Tailscale.

Required future provider:

- WireGuard.

The model remains open to:

- ZeroTier;
- NetBird;
- Headscale-backed Tailscale-compatible networks;
- site-to-site VPNs;
- provider-private networks;
- other authenticated overlay networks.

Project Space must not hard-code Tailscale semantics into SSH, Workspace, or runtime logic.

## 2.9 Access Route

An **Access Route** describes how Project Space can reach an Environment Instance or Host capability.

Examples:

```text
SSH over Tailscale
SSH over WireGuard
provider-native exec
JetKVM console
optional project-hostd channel
```

An SSH route contains at least:

- Environment Instance ID;
- private-network ID;
- address or resolvable private name;
- port;
- user;
- host-key identity;
- authentication credential reference;
- availability and last verification;
- priority and policy constraints.

An access route is not a Connector installation and is not shown as a separate machine-like inventory object.

## 2.10 Optional `project-hostd`

`project-hostd` is an optional small Rust service. It is not required for normal development and is not a replacement for SSH.

Its narrow responsibilities are:

- host and Environment Instance health;
- CPU, RAM, disk, and optional GPU telemetry;
- registered Workspace Runtime inventory;
- resource attribution to known runtimes;
- narrowly typed actions such as stopping or suspending a registered runtime;
- stale-runtime cleanup and bounded garbage collection;
- environment and host metadata that cannot be supplied reliably by individual Workspaces.

It must not own:

- arbitrary shell execution;
- Git operations;
- repository discovery;
- Codex installation or control;
- dev-server orchestration;
- project-specific configuration;
- general filesystem browsing.

The first implementation may be telemetry-only. Any later lifecycle actions must remain typed and allowlisted.

Because a physical Host cannot run a process independently of its active OS, `project-hostd` is installed in a native Environment Instance but may report Host-level resources when trustworthy host identity is available. Multiple boot environments may each have an installation, but Project Space does not expose those installations as separate Connectors.

## 2.11 Host console

A **Host Console** is an out-of-band screen, keyboard, and mouse capability associated with a Host.

JetKVM is the initial provider.

A console works independently of the active Environment Instance and therefore supports:

- power-on and reboot sequences;
- BIOS and UEFI;
- boot menus;
- GRUB;
- BitLocker or recovery screens;
- OS installation;
- login screens;
- frozen desktops.

---

# 3. Canonical relationships

```text
Environment Catalog
└── Environment Definition
    └── referenced by zero or more Environment Instances

Platform
├── Host
│   ├── power capabilities
│   ├── console endpoints
│   └── Environment Instance
│       ├── Environment Definition
│       ├── parent Environment Instance?
│       ├── access routes
│       ├── optional hostd endpoint
│       └── Workspace
│           └── Workspace Runtime
│               └── Runtime Session
└── Environment Instance                       host not applicable
    ├── Environment Definition
    ├── provider lifecycle
    ├── access routes
    └── Workspace Runtime
```

Required invariants:

1. Every Environment Instance references exactly one Environment definition.
2. Every Environment Instance belongs to exactly one Platform.
3. A Host belongs to exactly one Platform.
4. If an Environment Instance references a Host, both belong to the same Platform.
5. A child Environment Instance belongs to the same Platform as its parent.
6. A Workspace Runtime belongs to exactly one Workspace and one Environment Instance.
7. A Runtime Session cannot change its Workspace or Environment Instance identity.
8. A provider-managed Environment Instance may have no Host by design.
9. No Connector ID, hostname, IP address, or mutable container ID is silently promoted into Host or Environment Instance identity.

---

# 4. Identity, names, and target references

Internal identities should be opaque and stable. Human-readable aliases are separate.

Example:

```text
Environment definition
  id: envdef_01...
  slug: windows
  name: Windows

Environment Instance
  id: envi_01...
  alias: windows-01
  definition: windows
  platform: local
  host: os-pc
```

A second machine may contain:

```text
Environment Instance
  id: envi_02...
  alias: windows-02
  definition: windows
  platform: local
  host: os-work-2
```

Actions target the Environment Instance, not the catalog definition.

The unambiguous fully qualified reference is:

```text
<platform>/<host-or-provider-scope>/<environment-instance>
```

Examples:

```text
local/os-pc/windows-01
local/os-work-2/windows-02
github-codespaces/project-space-issue-454
```

When an alias is globally unique, the CLI may accept the shorthand `windows-01`. The resolver must still return the complete Platform, Host association, Environment definition, and access route before executing an action.

This avoids requiring callers to pass `--platform`, `--host`, and `--environment-instance` independently, which could create contradictory combinations.

---

# 5. Example inventories

## 5.1 Two Windows installations using one catalog definition

```text
Environment catalog
└── Windows

Platform: Local devices
├── Host: os-pc
│   └── Environment Instance: windows-01
│       └── Environment: Windows
└── Host: os-work-2
    └── Environment Instance: windows-02
        └── Environment: Windows
```

## 5.2 Native Windows with WSL

```text
Environment catalog
├── Windows
└── WSL Ubuntu

Platform: Local devices
└── Host: os-pc
    └── Environment Instance: windows-01
        ├── Environment: Windows
        └── Environment Instance: wsl-ubuntu-01
            └── Environment: WSL Ubuntu
```

SSH access may point directly to WSL, or it may traverse the Windows host through an explicitly configured forwarding route. Project Space stores the route on the concrete `wsl-ubuntu-01` instance.

## 5.3 GitHub Codespaces

```text
Environment catalog
└── GitHub Codespace

Platform: GitHub Codespaces · DotNaos
├── Environment Instance: project-space-issue-454
│   └── Environment: GitHub Codespace
└── Environment Instance: lexikon-issue-82
    └── Environment: GitHub Codespace
```

No fictional Host is created. Lifecycle and access can be provider-native, SSH-based, or both.

## 5.4 Worktree-scoped devcontainer

```text
Platform: Local devices
└── Host: os-pc
    └── Environment Instance: wsl-ubuntu-01
        └── Workspace: project-space / issue-454
            └── Workspace Runtime: devcontainer
                ├── Codex 0.x
                ├── project runtime
                ├── dependencies
                └── dev server
```

The devcontainer is not necessarily added to global compute inventory. It is owned by the Workspace and can disappear with it.

---

# 6. Discovery and inventory

Agents must discover the available catalog and concrete inventory before scheduling or controlling anything.

Proposed CLI:

```bash
project inventory
project inventory --json

project platform list
project platform show <platform>

project host list
project host list --platform <platform>
project host show <host>

# Environment catalog
project environment list
project environment show <environment-definition>

# Concrete instances
project environment instance list
project environment instance list --platform <platform>
project environment instance list --host <host>
project environment instance list --environment <definition>
project environment instance show <instance-ref>
```

`project inventory --json` is the primary agent discovery command. It should include:

- Environment catalog definitions;
- Platforms;
- Hosts and their Platform association;
- Environment Instances and their definition reference;
- parent/child instance relationships;
- resources and freshness;
- access-route capabilities without exposing secrets;
- Host power and console capabilities;
- running Workspace summaries;
- optional hostd availability;
- provider lifecycle state.

Illustrative shape:

```json
{
  "environmentCatalog": [
    { "id": "envdef_windows", "slug": "windows", "name": "Windows" },
    { "id": "envdef_wsl_ubuntu", "slug": "wsl-ubuntu", "name": "WSL Ubuntu" }
  ],
  "platforms": [
    {
      "id": "platform_local",
      "name": "Local devices",
      "hosts": [
        {
          "id": "host_os_pc",
          "name": "os-pc",
          "capabilities": {
            "power": ["wake-on-lan", "jetkvm"],
            "console": ["jetkvm"]
          },
          "environmentInstances": [
            {
              "id": "envi_windows_01",
              "alias": "windows-01",
              "environmentDefinitionId": "envdef_windows",
              "access": [
                {
                  "type": "ssh",
                  "networkProvider": "tailscale",
                  "available": true
                }
              ]
            }
          ]
        }
      ],
      "hostlessEnvironmentInstances": []
    }
  ]
}
```

Secrets, raw identity evidence, SSH private keys, and VPN credentials must never be returned in inventory JSON.

---

# 7. Correct remote-control path

A simplified diagram such as `Project Space -> SSH -> Environment` hides essential resolution steps. The actual flow is:

```text
Agent or user
    │
    │ selects Environment Instance
    ▼
Project Space target resolver
    ├── Environment definition: Windows
    ├── Environment Instance: windows-01
    ├── Platform: Local devices
    ├── Host: os-pc
    └── Access route: SSH over Tailscale
            │
            ▼
Trusted control gateway attached to the private network
            │
            │ SSH with verified host key
            ▼
Environment Instance: windows-01
            │
            ▼
project CLI
            │
            ▼
Workspace / Worktree lifecycle
```

The Host and Platform are therefore not missing. They are resolved from the concrete Environment Instance target.

Proposed action commands:

```bash
project environment instance shell local/os-pc/windows-01
project environment instance exec local/os-pc/windows-01 -- project workspace list --json
```

When `windows-01` is globally unique:

```bash
project environment instance shell windows-01
```

The control plane must resolve the same complete target before connecting.

---

# 8. SSH over private networks

## 8.1 Role of SSH

SSH is the primary command and bootstrap transport for local and self-managed Environment Instances.

SSH is used to:

- verify the installed Project CLI;
- install or explicitly update the Project CLI;
- create and remove worktrees;
- start, stop, suspend, or inspect Workspace Runtimes;
- start dev servers;
- start the Codex App Server;
- perform explicit interactive shell access;
- collect an on-demand resource snapshot when `project-hostd` is absent.

SSH is not the normal continuous telemetry path.

## 8.2 Private-network requirement

SSH routes must be reachable through an approved private network. Public Internet SSH is outside the default architecture.

```text
SSH
└── Private Network
    ├── Tailscale
    ├── WireGuard
    └── other provider
```

The SSH resolver depends only on a generic private-network interface:

- route availability;
- private address resolution;
- control-gateway membership;
- network policy status;
- optional provider metadata.

Tailscale-specific operations remain inside a Tailscale provider adapter. WireGuard-specific operations remain inside a WireGuard adapter.

## 8.3 Control gateway

The browser must not hold SSH private keys or direct private-network credentials.

SSH runs from a trusted **Control Gateway** that is attached to the selected private network. A gateway may be:

- the Project Space backend on a private VPS;
- a local Project Space desktop process;
- a dedicated control runner;
- a provider-native runner.

The gateway:

1. receives an authorized typed operation;
2. resolves the Environment Instance and access route;
3. verifies the SSH host key;
4. obtains the scoped credential;
5. invokes the remote `project` CLI;
6. returns structured output and audit metadata.

## 8.4 Authentication

Preferred SSH security properties:

- key or certificate authentication only;
- verified and pinned host keys;
- no password storage;
- short-lived SSH certificates where practical;
- per-gateway or per-environment principals;
- VPN ACLs that restrict the gateway to the required hosts and ports;
- audit logs for every remote operation;
- separate explicit authorization for interactive shells.

Normal lifecycle operations should invoke typed `project` CLI commands rather than constructing arbitrary shell fragments.

---

# 9. Bootstrap and persistent installation

A new self-managed Host or Environment Instance is prepared once through a bootstrap flow.

The bootstrap may:

1. create or resolve the Platform;
2. register the Host when applicable;
3. select an Environment catalog definition;
4. create the concrete Environment Instance;
5. configure its private-network membership;
6. configure SSH and register the host key;
7. install the stable Go `project` CLI;
8. optionally install `project-hostd`;
9. report initial resources and capabilities;
10. verify the complete access path.

The bootstrap does not install a large permanent Connector and does not install a global Codex version.

The Project CLI can be updated explicitly through a signed and versioned mechanism. Automatic unattended self-updates are not required for the base architecture.

The control plane performs a compatibility handshake before remote operations:

```text
server protocol version
project CLI version
supported command schema
minimum compatible version
```

If an update is required, Project Space can invoke an explicit signed CLI update over SSH before starting a Workspace Runtime.

---

# 10. Project CLI responsibilities

The `project` CLI remains implemented in Go and is installed persistently in each self-managed Environment Instance.

It owns stable host-side orchestration primitives:

- inventory and local capability reporting;
- worktree creation and deletion;
- Workspace Runtime creation and teardown;
- devcontainer or process-runtime launch;
- exact runtime manifest resolution;
- starting and stopping dev servers;
- starting the Codex App Server;
- issuing or retrieving short-lived runtime credentials;
- structured status output;
- explicit self-update.

The CLI should not become a permanent daemon. It is invoked through SSH, locally, by `project-hostd` for a narrow allowlisted operation if later required, or by a provider runner.

---

# 11. Ephemeral Workspace Runtime

The repository or Worktree defines the runtime it needs. A runtime manifest may pin:

- Codex version;
- container image or devcontainer configuration;
- language runtimes;
- package-manager versions;
- Project runtime protocol version;
- dev-server definitions;
- required ports;
- resource limits;
- startup and shutdown commands.

The exact manifest format is a separate implementation decision. The architectural requirement is that the Worktree, not the base Host installation, determines its development tooling.

Startup flow:

```text
Project Space
    │ SSH over private network
    ▼
project CLI on Environment Instance
    ├── creates or validates Worktree
    ├── resolves runtime manifest
    ├── prepares devcontainer or process group
    ├── installs/activates exact Codex version
    ├── starts runtime supervisor
    └── returns startup operation ID
```

Teardown flow:

```text
stop Workspace Runtime
├── stop Codex App Server
├── stop dev servers
├── flush final events
├── terminate process group/container
└── optionally remove ephemeral runtime state
```

The Git Worktree may persist after the runtime stops. Runtime lifecycle and checkout lifecycle are related but not identical.

---

# 12. Outbound runtime connection

After startup, the Workspace Runtime opens an authenticated outbound connection to Project Space.

```text
Workspace Runtime
    │ outbound TLS/WebSocket
    ▼
Project Space runtime gateway
```

This channel carries:

- startup completion;
- health and heartbeat events;
- runtime state transitions;
- dev-server state and URLs;
- port metadata;
- logs or log pointers;
- workspace-scoped telemetry;
- current commit and branch evidence;
- graceful shutdown and failure events.

The runtime uses a short-lived credential scoped to:

- one Workspace;
- one Environment Instance;
- one runtime generation;
- an explicit capability set;
- a bounded lifetime.

Recreating the runtime creates a new generation and invalidates the old runtime channel.

Project Space marks a runtime stale when heartbeats expire. It does not infer that the underlying Host or Environment Instance is offline solely from one missing Workspace Runtime.

---

# 13. Codex App Server WebSocket

The Project CLI starts the Codex App Server inside the Workspace Runtime. The App Server then opens or joins an outbound WebSocket channel to Project Space.

```text
SSH command
    ▼
project CLI
    ▼
Workspace Runtime
    ▼
Codex App Server
    │ outbound WebSocket
    ▼
Project Space
```

After connection, the WebSocket supports:

- thread and session discovery;
- streaming events;
- queueing work;
- steering a running session;
- tool and approval events;
- status and lifecycle updates;
- reconnect and resume semantics.

SSH does not remain open for the lifetime of the Codex session.

The Codex channel may be multiplexed through the Workspace runtime supervisor or connected directly by the Codex App Server. In either case, authentication remains Workspace- and generation-scoped.

---

# 14. Development servers

Development servers are started through a typed Project CLI operation over SSH.

```text
Project Space
    │ SSH: start dev server
    ▼
project CLI
    ▼
Workspace Runtime
    ├── starts process
    ├── verifies listener
    ├── determines private URL
    └── reports status outbound
```

Once started, state comes from the outbound runtime channel instead of repeated SSH polling.

A dev-server record includes:

- Workspace ID;
- server definition ID;
- runtime generation;
- process state;
- listener address and port;
- private-network URL;
- health state;
- last verified time;
- optional public or preview deployment URL when separately authorized.

Private publication must use the selected private-network provider abstraction rather than hard-coded Tailscale commands in the domain model.

---

# 15. Optional `project-hostd` and resource management

## 15.1 Why it is optional

All normal development operations must work with:

```text
private network + SSH + project CLI
```

Without `project-hostd`, Project Space can:

- start and stop Workspaces over SSH;
- receive Workspace telemetry outbound;
- request an occasional on-demand resource snapshot through the CLI.

## 15.2 Why it is still useful

Individual Workspace Runtimes only know their own resource use. Project Space also needs environment- and host-wide context to answer:

- Is total RAM nearly exhausted?
- Is disk space critically low?
- Which registered Workspace consumes the most memory?
- Which idle runtimes can be stopped safely?
- Are uncollected ephemeral worktrees filling storage?
- Is a GPU oversubscribed?

`project-hostd` supplies continuous low-cost telemetry without SSH polling.

## 15.3 Resource attribution

Where possible, each Workspace Runtime should run inside an attributable boundary:

- container ID and labels;
- cgroup;
- systemd transient unit;
- Windows Job Object;
- process group with a persisted runtime generation;
- provider-native allocation.

`project-hostd` reports only registered Workspace boundaries and aggregate Host/Environment resources. It must not silently classify unrelated user processes as Project Space Workspaces.

## 15.4 Resource policy

The Control Plane owns policy decisions. Example:

```text
available memory below threshold
    ▼
rank active Workspace Runtimes
    ├── protected / interactive
    ├── running task
    ├── idle
    └── disposable
    ▼
request stop for an eligible runtime
```

`project-hostd` executes only the selected typed action. It does not independently decide which user workload to kill.

## 15.5 Service security

Preferred `project-hostd` properties:

- Rust implementation;
- small dependency set;
- outbound-only authenticated connection where possible;
- mTLS or equivalent device credentials;
- typed, versioned protocol;
- no general `exec` endpoint;
- no public listener;
- no repository secrets;
- no automatic project-tool installation;
- explicit signed upgrades only;
- full audit trail for lifecycle actions.

If SSH is unavailable, `project-hostd` may still provide telemetry and narrowly scoped recovery actions. It does not automatically become a general remote shell replacement.

---

# 16. Host power and JetKVM console

Host-level commands target a Host, not an Environment catalog definition or Environment Instance.

Proposed CLI:

```bash
project host power status <host>
project host power on <host>
project host power off <host>

project host console screenshot <host> --output screen.png
project host console key <host> F2
project host console chord <host> CTRL ALT DELETE
project host console type <host> "text"
project host console mouse move <host> 500 300
project host console mouse click <host> 500 300
```

JetKVM is one console provider:

```text
Host: os-pc
├── Power provider: JetKVM / Wake-on-LAN
└── Console endpoint: JetKVM
    ├── HDMI capture
    ├── USB HID keyboard
    └── USB HID mouse
```

Agent loop:

```text
JetKVM frame
    ▼
PNG screenshot
    ▼
vision-capable model
    ▼
keyboard or mouse decision
    ▼
JetKVM HID input
    ▼
new frame
```

This control path is independent of SSH and the active OS. High-risk console actions must be audited and may require explicit approval, especially for firmware changes, disk operations, secure-boot settings, and destructive installers.

---

# 17. Provider-managed environments

Not every Platform uses SSH in the same way.

A provider-managed Environment Instance may offer:

- provider-native start/stop/delete;
- provider-native terminal execution;
- SSH after provisioning;
- an outbound Runtime Session only;
- a provider-supplied private network.

The control resolver selects the highest-priority authorized capability for the requested operation.

Example for GitHub Codespaces:

```text
Platform: GitHub Codespaces · DotNaos
Environment Instance: project-space-issue-454
Environment definition: GitHub Codespace
Host: not applicable
Lifecycle: GitHub provider API
Shell: provider exec or SSH
Runtime channel: outbound WebSocket
```

The Workspace and Runtime model remains the same even when provisioning differs.

---

# 18. Security boundaries

## 18.1 Persistent trust surface

The persistent trust surface on a self-managed Environment Instance is intentionally small:

```text
SSH server
project CLI
optional project-hostd
private-network client
```

Codex, repository dependencies, and dev servers are not part of that permanent trusted base.

## 18.2 Separation of responsibilities

```text
SSH
└── general authenticated transport and explicit shell

project CLI
└── typed bootstrap and lifecycle operations

Workspace Runtime
└── project-specific execution and outbound state

project-hostd
└── optional resources and narrow lifecycle actions

JetKVM
└── out-of-band Host console
```

## 18.3 Credentials

- SSH private keys remain in the Control Gateway's secure credential store.
- VPN keys remain with the private-network provider and gateway.
- Runtime credentials are short-lived and Workspace-scoped.
- `project-hostd` credentials are device-scoped and cannot authorize arbitrary SSH.
- JetKVM credentials are Host-console-scoped.
- The browser receives capability summaries, never raw credentials.

## 18.4 Authorization

Authorization is evaluated before route resolution and again before execution. The policy target includes:

- user or agent identity;
- Platform;
- Host when applicable;
- Environment Instance;
- Workspace;
- requested capability;
- operation risk;
- runtime generation.

An authorization for `start-dev-server` does not imply authorization for an interactive shell or BIOS keyboard control.

---

# 19. Failure and recovery behavior

## SSH unavailable

- Existing Workspace Runtime channels may remain operational.
- New Workspace startup is unavailable through SSH.
- `project-hostd`, when installed, can continue telemetry and narrow recovery actions.
- JetKVM may be used to recover the Host.
- Provider-native execution may be selected for managed environments.

## Runtime WebSocket disconnected

- Project Space marks the Runtime Session stale after its heartbeat window.
- SSH or provider control can inspect or restart the runtime.
- Reconnection must prove the same runtime generation.

## `project-hostd` unavailable

- Development continues through SSH.
- Workspace telemetry continues.
- Host-wide resource state becomes stale until an on-demand SSH snapshot succeeds.

## Private network unavailable

- SSH routes using that network become unavailable.
- Another configured private-network or provider route may be selected.
- Project Space does not fall back to public SSH automatically.

## Host powered off

- Environment Instances on the Host are offline.
- Host power and JetKVM capabilities remain available when their independent route is online.

## Disk or memory pressure

- Workspace telemetry and optional hostd evidence identify candidates.
- The Control Plane applies explicit policy.
- Only registered runtime boundaries are stopped automatically.

---

# 20. Migration from the current Connector

The target model removes Connector installations from the primary user-facing compute hierarchy.

Current responsibilities migrate as follows:

| Current Connector responsibility | Target owner |
| --- | --- |
| registration and environment identity | bootstrap + Environment Instance record |
| online status | access-route checks, provider state, runtime sessions, optional hostd |
| remote command execution | SSH over private network |
| project/worktree discovery | typed Project CLI operations |
| Codex version and launch | Workspace Runtime manifest + Project CLI |
| Codex streaming and steering | Codex App Server outbound WebSocket |
| dev-server lifecycle | Project CLI start/stop + outbound runtime events |
| Tailscale publication | private-network provider adapter |
| resource reporting | runtime telemetry + optional hostd |
| connector self-update | explicit Project CLI update; rare explicit hostd upgrade |

Migration principles:

1. Keep current connector APIs operational while additive SSH and runtime paths are introduced.
2. Add Environment definitions without changing existing concrete environment IDs.
3. Treat existing `ComputeEnvironmentRecord` rows as Environment Instances during migration.
4. Add definition references to those instances.
5. Add private-network and SSH access routes.
6. Move new Workspace launches to SSH and outbound Runtime Sessions.
7. Stop creating additional connector installations for new Worktrees or tool versions.
8. Hide Connector installations from the primary inventory UI once equivalent capabilities exist.
9. Retire the Connector only after all required operations have migrated.
10. Never reinterpret a legacy Connector ID as a Host or Environment Instance ID.

---

# 21. Proposed implementation stages

## Stage 1: Documentation and additive domain model

- Introduce Environment catalog definitions.
- Introduce explicit Environment Instance terminology.
- Add definition references to the inventory API.
- Keep current connector behavior unchanged.
- Add complete inventory JSON for agents.

## Stage 2: Platform, Host, and Instance discovery CLI

- Add `platform`, `host`, and Environment catalog commands.
- Add Environment Instance list/show commands.
- Support fully qualified target references.
- Expose capability summaries and route availability.
- Keep `machine` as a temporary compatibility alias.

## Stage 3: Private-network and SSH control

- Add generic Private Network records.
- Implement Tailscale provider first.
- Add WireGuard provider contract and later implementation.
- Add trusted Control Gateway execution.
- Add SSH host-key verification and scoped credentials.
- Invoke typed Project CLI operations remotely.

## Stage 4: Ephemeral Workspace Runtime

- Define runtime manifest contract.
- Start Worktree runtimes over SSH.
- Pin Codex and dependencies per Worktree.
- Support process mode and optional devcontainer mode.
- Add runtime generation IDs.

## Stage 5: Outbound runtime and Codex channels

- Add runtime registration credentials.
- Add outbound event/telemetry channel.
- Add Codex App Server WebSocket routing.
- Add reconnect, stale-state, and resume semantics.
- Remove SSH polling for active runtime state.

## Stage 6: Optional Rust `project-hostd`

- Start with health and resource telemetry.
- Add registered runtime attribution.
- Add narrowly typed stop/suspend operations only when required.
- Verify that all development flows still work without the service.

## Stage 7: Host console and JetKVM

- Model console and power providers on Hosts.
- Add screenshot, keyboard, and mouse CLI primitives.
- Add agent-oriented PNG capture loop.
- Add approvals and audit policy for high-risk actions.

## Stage 8: Connector retirement

- Migrate remaining operations.
- Remove Connector installations from primary inventory.
- preserve explicit compatibility endpoints for old clients during the deprecation window;
- remove the large permanent Connector once usage reaches zero.

---

# 22. Architectural invariants

The implementation should preserve these rules:

- Environment means reusable catalog definition.
- Environment Instance means concrete scheduling and control target.
- Windows on two Hosts is one Environment definition with two Environment Instances.
- Platform and Host associations are never inferred from display names alone.
- Actions target an Environment Instance or Host, never a catalog definition.
- SSH is used only through an approved private-network route.
- Tailscale is a provider implementation, not a domain assumption.
- WireGuard must fit without changing Workspace or SSH domain logic.
- The Project CLI remains a non-daemon Go binary.
- Worktree runtimes own Codex and project-specific dependencies.
- Active runtimes report their own status outbound.
- Codex App Server control uses an outbound WebSocket after startup.
- `project-hostd` is optional and cannot be required for development.
- `project-hostd` has no arbitrary remote shell interface.
- JetKVM is a Host capability, not an Environment Instance or Connector.
- Runtime Sessions and access routes are not displayed as machine-like inventory entities.
- The permanent trusted software surface on target machines remains minimal.
