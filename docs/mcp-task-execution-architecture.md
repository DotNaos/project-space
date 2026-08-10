---
title: MCP Task Execution and Sandbox Lifecycle Architecture
description: Canonical architecture and delivery plan for completing Project Space tasks through remote MCP orchestrators and local or cloud agent environments.
---

# MCP Task Execution and Sandbox Lifecycle Architecture

## Status and purpose

This document defines the target architecture and implementation plan for
completing an entire Project Space task through the remote MCP server. It is the
coordination contract for the Web UI, MCP clients, compute providers,
connectors, agent runtimes, task providers, workspaces, pull-request delivery,
and production evidence.

The intended orchestrators include ChatGPT, ChatGPT Work, Codex, Claude, and
future MCP clients. Codex is the first implementation agent. Claude or another
agent may be added later without changing the task, environment, handoff, or
delivery models.

The architecture must support both:

- persistent, connector-backed Environments such as native macOS, Linux,
  Windows, and WSL; and
- provider-managed Environments such as GitHub Codespaces and future cloud
  sandboxes that must be provisioned, started, stopped, and eventually deleted.

This is an additive plan. Existing GitHub and Codex tools remain available as
compatibility aliases until every caller has migrated.

## Decisions at a glance

1. **Task** is the provider-neutral product term. GitHub Issue is the first
   provider implementation; Azure DevOps can be added later.
2. **Environment** is the execution and scheduling target. A physical Host is
   optional topology metadata and is never a universal prerequisite.
3. **Connector installation** is an authenticated transport inside exactly one
   Environment. It is not a Host, Environment, runner, or agent identity.
4. **Agent Runtime** identifies Codex today and a future Claude runtime later.
5. **Task Execution** is one durable implementation attempt. Its identity is
   independent of a Codex thread ID.
6. **Handoff** is a structured, immutable, versioned briefing rather than a
   long prompt assembled at task start.
7. **Operation** supplies idempotency and reconciliation for every mutation.
   Unknown outcomes are represented as `uncertain`, never guessed as success or
   retried with a new identity.
8. **Web UI and MCP share services.** Neither surface reimplements GitHub,
   Codespaces, connector, Codex authorization, worktree, or delivery logic.
9. **Shell commands are asynchronous and scoped.** Normal workspace commands
   and provider recovery commands use separate authorization paths.
10. **Completion requires evidence.** A Codex final message, green workflow,
    merged pull request, or deployed version alone is not sufficient proof of
    the complete lifecycle.

## Related architecture and active work

This document builds on, rather than replaces:

- [Compute Platforms, Hosts, and Environments](compute-environments.md)
- [Project Space Connector](connector.md)
- [Codex Worktree Ownership](codex-worktrees.md)
- [Codex session transport and security](codex-sessions.md)
- [Remote Project Space MCP](project-mcp.md)
- [Project Space Control Plane](control-plane-plan.md)

Relevant GitHub delivery work:

- [Issue #531](https://github.com/DotNaos/project-space/issues/531) tracks this
  architecture and work breakdown.
- [Issue #456](https://github.com/DotNaos/project-space/issues/456) and
  [PR #529](https://github.com/DotNaos/project-space/pull/529) implement the
  first production GitHub Codespaces execution path.
- [Issue #451](https://github.com/DotNaos/project-space/issues/451) is the
  one-click Codespaces delivery epic. Its existing follow-up work includes
  [Issue #455](https://github.com/DotNaos/project-space/issues/455) for GitHub
  App provisioning and deletion,
  [Issue #457](https://github.com/DotNaos/project-space/issues/457) for
  idempotent Codex autostart and resume, and
  [Issue #458](https://github.com/DotNaos/project-space/issues/458) for private
  Codex App Server and development-server connectivity.
- [PR #525](https://github.com/DotNaos/project-space/pull/525) added the current
  GitHub task lifecycle tools to MCP.
- [PR #522](https://github.com/DotNaos/project-space/pull/522) added Codex OAuth
  callback support for the remote MCP server.
- [PR #523](https://github.com/DotNaos/project-space/pull/523) tracks the
  remaining macOS managed-Codex handoff work.
- [Issue #446](https://github.com/DotNaos/project-space/issues/446) is the
  earlier portable runner architecture work.

PR #529 supersedes the terminal-first Codespaces approach in draft PR #461.
Sound bootstrap and readiness ideas may be retained, but UI and MCP must use the
new shared provider service and the canonical compute Environment identity.

## Current MCP surface

The remote MCP exposes fifteen tools after WP1.

### Project and task discovery

- `list_projects`
- `list_tasks`
- `get_task`
- `get_task_status`
- `list_task_comments`

### Task mutations

- `create_task`
- `update_task`
- `add_task_comment`

### Connector and Codex discovery

- `list_execution_environments`
- `get_execution_environment`
- `list_machines`
- `list_codex_tasks`
- `read_codex_task`

### Codex mutations

- `start_codex_task`
- `send_codex_message`

These tools prove the remote OAuth, task-provider, canonical Environment,
connector, Codex session, and worktree path. They do not yet provide the
complete task lifecycle because:

- `list_machines` remains a deprecated historical connector/machine
  compatibility projection;
- `start_codex_task` is Codex- and GitHub-specific;
- no structured handoff is stored;
- no generic Task Execution identity exists;
- cloud Environment lifecycle is not available through MCP;
- Codex device authorization is not available through MCP;
- approval, input, cancellation, archive, and wait operations are incomplete;
- shell recovery is not safely exposed;
- pull-request review, merge, delivery evidence, and task completion are not
  modeled end to end.

## Canonical domain model

### Compute topology

The existing compute hierarchy is authoritative:

```text
Platform
├── Host?                              optional
│   └── Environment                    execution target
│       └── Connector installation(s)  authenticated channels
└── Environment                       provider-managed Host is hidden
    └── Connector installation(s)
```

The meanings are:

| Identity | Purpose | Execution target? | Durable while stopped? |
| --- | --- | --- | --- |
| Platform | Groups capacity by provider or allocation source | No | Yes |
| Host | Optional physical or virtual device and host-wide capacity | No | Yes |
| Environment | Concrete schedulable runtime boundary | Yes | Yes |
| Connector | Authenticated transport installed in one Environment | No | Credential yes; session no |
| Connector generation | One live connector connection epoch | No | No |
| Agent Runtime | Codex or another executable agent inside an Environment | Selected capability | Installation may persist |
| Runner Workspace | Isolated checkout and task-local state | Used by one execution | Policy-dependent |

Examples:

```text
Platform: Local devices
└── Host: Workstation
    ├── Environment: Windows
    └── Environment: WSL Ubuntu
        └── Connector: stable

Platform: GitHub Codespaces
└── Environment: project-space / task 456
    └── Connector: managed runner, only while the Codespace is running
```

A Codespace is a provider-managed `github_codespace` Environment with
`hostAssociation.resolution = not_applicable`. It must never be assigned a
fictional physical Host merely to satisfy a legacy selector.

### Task

`Task` is the provider-neutral work request.

```ts
interface TaskRef {
  id: string;                 // canonical Project Space identity
  provider: 'github';        // Azure DevOps later
  providerTaskId: string;
  projectId: string;
  repositoryId?: string;
  title: string;
  state: 'open' | 'closed';
  url?: string;
}
```

The initial GitHub adapter continues mapping GitHub Issues to Tasks. Provider
fields belong under provider bindings and must not leak into neutral execution
or handoff identifiers.

### Handoff

A handoff is an immutable briefing revision supplied by an orchestrator or
human. It is not an executor transcript and not an authorization grant.

```ts
interface TaskHandoff {
  id: string;
  revision: number;
  taskId: string;
  objective: string;
  context: string;
  decisions: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  artifacts: HandoffArtifactRef[];
  requestedMode: 'plan' | 'implement' | 'review' | 'repair';
  requestedPermissions: {
    delivery: 'none' | 'pull_request';
    network: 'none' | 'restricted' | 'open';
    repository: 'read' | 'write';
    task: 'read' | 'write';
    workspace: 'read' | 'write';
  };
  createdBy: ActorRef;
  createdAt: string;
}
```

Artifacts are owner-scoped stored bytes with media type, digest, size,
authorization, verification time, and opaque client provenance. MCP clients
may provide bounded inline UTF-8/base64 content or reuse an artifact from an
already verified Handoff for the same Task. They cannot provide arbitrary
target-machine paths or unrestricted URLs. A design produced by Claude can
therefore be handed to Codex on another machine as a verified artifact and
exact Handoff revision. Requested permissions remain a request; the Handoff is
not an authorization grant.

Changing a handoff creates a new revision. A running Task Execution retains the
revision it started with unless an explicit `update_task_execution_handoff`
operation records the change.

### Task Execution

`TaskExecution` is the durable identity for one implementation attempt.

```ts
interface TaskExecution {
  id: string;
  taskId: string;
  handoff: { id: string; revision: number };
  agent: AgentRuntimeSelector;
  environmentId: string;
  connectorBinding?: {
    connectorId: string;
    generation: number;
  };
  workspace?: RunnerWorkspaceRef;
  executorBinding?: {
    kind: 'codex';
    threadId: string;
    turnId?: string;
  };
  state: TaskExecutionState;
  blockedReason?: TaskExecutionBlockedReason;
  delivery?: TaskDeliveryRef;
  createdAt: string;
  updatedAt: string;
}
```

The Codex `threadId` remains important, but it is an executor-specific binding,
not the universal Task Execution ID. A future Claude execution can use a
different binding without changing MCP tools or stored task history.

### Operation

Every mutating request uses a caller-supplied operation ID and a canonical
fingerprint of its input.

```text
reserved -> dispatched -> confirmed -> completed
                    \-> blocked
                    \-> uncertain -> reconciled -> completed | blocked
```

Rules:

- The same operation ID and same fingerprint replay the prior result.
- The same operation ID with different input is a conflict.
- A new operation ID must not be generated merely because a response was lost.
- An uncertain provider, connector, agent, Git, PR, merge, or deploy boundary
  is reconciled before another mutation is attempted.
- Operation results include `operationId`, state, target evidence, timestamps,
  and a safe request/correlation ID.

## Environment lifecycle

Environment lifecycle is provider-owned and independent from connector, agent,
authorization, and task state.

```text
missing
  -> provisioning
  -> stopped
  -> starting
  -> running
  -> stopping
  -> stopped
  -> deleting
  -> deleted

Any non-terminal state may enter failed or uncertain.
```

Normalized provider states should remain deliberately small:

```ts
type EnvironmentLifecycleState =
  | 'missing'
  | 'provisioning'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'deleting'
  | 'deleted'
  | 'failed'
  | 'uncertain';
```

Provider-native state is retained separately for diagnosis. For example,
GitHub may report `Available` or `Shutdown`; Project Space maps that value to a
normalized lifecycle state but also returns the original value and observation
time.

Stopping a Codespace is not a connector failure. The durable Environment stays
known while its connector session correctly becomes absent.

## Readiness is composed evidence

The system must not collapse provider, connector, agent, authorization, and
capacity state into one inferred boolean.

```text
EnvironmentReady
=> ProviderRunningEvidence is fresh
&& ConnectorBindingEvidence is fresh
&& ConnectorGeneration is current
&& RequiredConnectorCapabilities are present
&& AgentRuntimeEvidence is fresh
&& AgentAuthorizationEvidence is ready
&& WorkspacePrerequisiteEvidence is valid
&& CapacityLeaseEvidence permits another execution
```

Evidence objects:

| Evidence | Producer | Invalidated by |
| --- | --- | --- |
| `ProviderLifecycleEvidence` | Environment provider | expiry, provider mutation, deletion |
| `ConnectorBindingEvidence` | compute inventory reconciliation | revoke, re-enroll, identity conflict |
| `ConnectorSessionEvidence` | connector hub | disconnect, new generation, expiry |
| `AgentRuntimeEvidence` | connector readiness probe | runtime update, restart, expiry |
| `AgentAuthorizationEvidence` | agent account read | logout, missing storage, expiry, failed refresh |
| `WorkspaceEvidence` | provider and Project worktree inventory | deletion, branch/commit mismatch, broken registration |
| `CapacityLeaseEvidence` | execution scheduler | lease expiry, cancellation, terminal execution |
| `DeliveryEvidence` | task provider, CI, deploy provider | new commit, rerun, rollback, newer deployment |

The earliest honest user-visible state is `checking`. A later action is enabled
only after its required evidence exists. Missing evidence produces
`blocked(reason)` or retains the last explicitly marked safe snapshot.

## GitHub Codespaces shared contract

PR #529 defines the first provider implementation. UI and MCP must consume the
same contract.

### Shared request and result

The canonical current file is:

```text
src/shared/github-codespace-runner-api.ts
```

The exact request is:

```ts
interface GitHubCodespaceRunnerRequest {
  action: 'provision' | 'start' | 'status' | 'stop' | 'delete';
  branch: string;
  issue: number;
  operationId: string;
  repositoryFullName: string;
}
```

`operationId` is caller supplied and must match `Idempotency-Key` at the HTTP
boundary. The current UI uses `codespace:<uuid>`.

The exact result contains:

```ts
interface GitHubCodespaceRunnerResult {
  apiVersion: 1;
  operationId: string;
  state:
    | 'not-created'
    | 'provisioning'
    | 'connector-approval-required'
    | 'authorization-required'
    | 'ready'
    | 'offline'
    | 'github-reauthorization-required'
    | 'failed';
  message: string;
  codespace?: { name: string; state: string; url?: string };
  approvalUrl?: string;
  connectorId?: string;
  environmentId?: string;
}
```

`environmentId` is the durable canonical execution target. `connectorId` is
runtime evidence that becomes available after the Codespace starts and its
managed connector enrolls.

### Reusable provider service

The UI-independent lifecycle service is:

```text
server/github-codespace-runner/service.ts
createGitHubCodespaceRunnerService(dependencies)
GitHubCodespaceRunnerDependencies
GitHubCodespaceRecord
```

It owns:

- provision, start, status, stop, and delete reconciliation;
- repository and branch matching, a preference for the exact display name
  `Project Space #<issue>`, and fail-closed ambiguous duplicate handling;
- uncertain-create reconciliation before retry;
- exact connector and compute Environment matching;
- connector approval-required state derivation;
- Codex authorization-required and ready derivation.

The configured GitHub adapter must be shared too. PR #529 provides:

```text
server/github-codespace-runner/configured-runtime.ts
GitHubCodespaceRunnerRuntime
GitHubCodespaceRunnerRuntimeDependencies
GitHubCodespaceRunnerAuthenticationError
createGitHubCodespaceRunnerRuntime(dependencies)
createConfiguredGitHubCodespaceRunnerRuntime({ backend })
```

`GitHubCodespaceRunnerRuntime` exposes one UI-independent
`run(request): Promise<GitHubCodespaceRunnerResult>` boundary. The configured
runtime owns the OAuth scope check, GitHub REST adapter, advisory-lock
serialization, compute inventory, and database connector-approval lookup. The
lifecycle service decides when approval is required and consumes that lookup.

The Web UI creates this runtime once in `server/project-space-http.ts` and
passes it to `createGitHubCodespaceRunnerHttpHandler({ runtime })`. Future MCP
code must receive and call the same runtime instance in-process under
`runWithAuthSession`. MCP must not duplicate GitHub REST requests and must not
call the public HTTP route through a loopback network request.

Mutating Codespaces operations remain serialized by repository, task, and
branch. `status` remains read-only.

## Agent runtime and Codex authorization

### Agent runtime model

```ts
interface AgentRuntimeRecord {
  kind: 'codex';              // 'claude' later
  environmentId: string;
  version?: string;
  capabilities: string[];
  state: 'missing' | 'installing' | 'ready' | 'failed' | 'unknown';
  checkedAt: string;
}
```

Connector capabilities are evidence reported by an Agent Runtime adapter. They
must not redefine the Environment identity.

### Codex subscription authorization

Codex uses ChatGPT subscription authentication. API-key fallback is forbidden
for managed task Environments.

The existing authorization service supports:

- actions `start`, `status`, and `cancel`; and
- states `authorization-required`, `pending`, `ready`, `expired`, `cancelled`,
  `failed`, `ambiguous`, `offline`, `unauthorized`, and `unsupported`.

The connector invokes Codex App Server `account/login/start` with
`chatgptDeviceCode`, returns only the verification URL and user code, and polls
`account/read` for actual readiness. Tokens and refresh credentials never
cross the connector boundary.

PR #529 extends `CodexAuthorizationSelector` with `environmentId`. Its physical
selector fields remain v1 compatibility inputs. The `physicalMachine` result
projection on `CodexMachineTaskTarget` is explicitly deprecated. New MCP and UI
calls select the Environment.

Authorization evidence is checked after every Environment start. A stored
record that says the user was previously logged in is not proof that a rebuilt,
deleted, expired, or restored sandbox is currently authorized.

## Task Execution lifecycle

```text
planned
  -> preparing_environment
  -> waiting_for_connector
  -> waiting_for_authorization
  -> preparing_workspace
  -> starting_agent
  -> running
  -> waiting_for_approval | waiting_for_input
  -> verifying
  -> delivering
  -> completed

Any active state may enter blocked, failed, cancelled, or uncertain.
Blocked may resume only after its named gate has fresh evidence.
Uncertain must reconcile before another mutation.
```

Suggested execution states:

```ts
type TaskExecutionState =
  | 'planned'
  | 'preparing_environment'
  | 'waiting_for_connector'
  | 'waiting_for_authorization'
  | 'preparing_workspace'
  | 'starting_agent'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_input'
  | 'verifying'
  | 'delivering'
  | 'blocked'
  | 'uncertain'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived';
```

Blocked reasons should be stable machine-readable values, including:

- `environment_not_running`
- `connector_required`
- `connector_stale`
- `agent_runtime_missing`
- `agent_authorization_required`
- `approval_required`
- `input_required`
- `workspace_failure`
- `capacity_unavailable`
- `provider_authorization_required`
- `required_check_failed`
- `review_required`
- `delivery_unverified`

## Complete MCP workflow

The high-level workflow is:

```text
discover Task
-> create or select Handoff revision
-> select Environment and Agent Runtime
-> reserve Task Execution
-> provision/start Environment when necessary
-> wait for connector and readiness evidence
-> complete device authorization when necessary
-> materialize exact Runner Workspace
-> start agent binding
-> observe, message, approve, answer, repair, or cancel
-> verify implementation
-> create/update pull request
-> wait for CI and review
-> merge only with current-revision approval
-> verify delivery and production state when required
-> close/complete Task
-> stop or retain Environment according to policy
-> archive Task Execution
```

An orchestrator may use individual tools for diagnosis, but
`start_task_execution` owns the normal preparation pipeline. It should start a
stopped Environment automatically and return an actionable blocked result when
human provider approval or Codex device login is needed.

## Target MCP tool catalogue

### Existing tools retained

| Tool | Decision |
| --- | --- |
| `list_projects` | Retain |
| `list_tasks` | Retain and add provider pagination/cursor later |
| `get_task` | Retain |
| `get_task_status` | Retain; eventually compose execution and delivery evidence |
| `create_task` | Retain |
| `update_task` | Retain |
| `list_task_comments` | Retain |
| `add_task_comment` | Retain; document non-idempotent retry behavior |
| `list_machines` | Deprecate in favor of `list_execution_environments` |
| `list_codex_tasks` | Compatibility alias for `list_task_executions(agent = codex)` |
| `read_codex_task` | Compatibility alias for `get_task_execution` |
| `start_codex_task` | Compatibility alias for `start_task_execution(agent = codex)` |
| `send_codex_message` | Compatibility alias for `send_task_execution_message` |

### Environment discovery and lifecycle

#### `list_execution_environments`

Arguments:

- optional `platform`
- optional `kind`
- optional `capability`
- optional `lifecycleState`
- optional `includeStopped`

Returns Platforms, optional Hosts, Environments, connector associations,
provider lifecycle evidence, resources, capacity, Agent Runtime summaries, and
supported lifecycle actions. Read-only and safe to retry.

#### `get_execution_environment`

Arguments: `environmentId`.

Returns one exact Environment with fresh provider, connector, runtime,
authorization, workspace, and capacity evidence. Read-only and safe to retry.

#### `provision_execution_environment`

Arguments:

- `provider`
- `repositoryId`
- `task`
- `branch`
- optional provider profile such as machine size
- `operationId`

Returns the durable `environmentId` when known, provider resource projection,
normalized lifecycle state, native provider state, and reconciliation evidence.
Write scope; idempotent for the same fingerprint.

For GitHub Codespaces this delegates to the shared PR #529 runtime with
`action = provision`.

#### `start_execution_environment`

Arguments: `environmentId`, `operationId`.

Returns lifecycle state and latest readiness summary. Write scope; idempotent.
For GitHub Codespaces, the provider binding resolves the existing repository,
task, and branch required by `GitHubCodespaceRunnerRequest`.

#### `stop_execution_environment`

Arguments: `environmentId`, `operationId`, optional `reason`.

Write scope; idempotent. It must refuse to stop an Environment with an active
execution unless cancellation or an explicit policy transition has already
released the lease.

#### `delete_execution_environment`

Arguments: `environmentId`, `operationId`.

Destructive write scope. WP2 proves that no execution or uncertain operation is
active. The later Task Execution and Delivery work packages add proof for
unpublished branches, unreviewed changes, and retained artifacts before the
complete deletion policy is enabled. Deletion never becomes an automatic retry
after an uncertain response. An evidence receipt remains deferred until Project
Space has an authoritative verifier for those delivery and artifact dependencies.

### Agent runtime and authorization

#### `get_agent_status`

Arguments: `environmentId`, `agent`.

Returns installed version, runtime state, connector capabilities,
authorization state, and observation time. Read-only.

#### `start_agent_authorization`

Arguments: `environmentId`, `agent`, `operationId`.

For Codex, returns `pending`, verification URL, user code, deadline, and polling
guidance. It never returns tokens. Write scope; idempotent for the same login
attempt.

#### `get_agent_authorization`

Arguments: `environmentId`, `agent`, `operationId`.

Returns `authorization-required`, `pending`, `ready`, `expired`, `cancelled`,
`failed`, `ambiguous`, `offline`, `unauthorized`, or `unsupported`. Read-only
status reconciliation.

#### `cancel_agent_authorization`

Arguments: `environmentId`, `agent`, `operationId`.

Cancels only the exact active attempt. Write scope; idempotent.

### Handoff

#### `create_task_handoff`

Arguments: a canonical provider Task locator, structured objective, context,
decisions, acceptance criteria, constraints, bounded inline artifacts or
verified prior-Handoff artifact references, requested mode, explicit requested
permissions, and `operationId`.

Returns an immutable handoff ID and revision. Write scope; idempotent for the
same content fingerprint.

#### `get_task_handoff`

Arguments: `handoffId`, optional revision.

Returns the sanitized immutable briefing and verified artifact content directly
over MCP. Read-only and owner-scoped.

#### `update_task_execution_handoff`

Arguments: `executionId`, `handoffId`, `revision`, `operationId`.

Allowed only before an executor is bound and while the execution remains in a
safe pre-start state. The versioned transition is recorded in execution
history. Write scope; idempotent.

### Task Execution

#### `start_task_execution`

Arguments:

- `taskId`
- `handoffId` and revision, or an inline handoff draft
- `environmentId`, or a provider selection policy
- `agent`, defaulting to `codex` for the first implementation
- optional model and effort settings supported by the selected runtime
- `operationId`
- optional `dryRun`

`dryRun` proves task, target, provider capability, authorization prerequisites,
and policy without provisioning, starting, or creating a worktree.

The normal call reserves one Task Execution and advances it until running,
blocked, failed, cancelled, or uncertain. Replaying the operation never creates
a second Environment, connector enrollment, branch, worktree, thread, or task
execution.

#### `list_task_executions`

Arguments: optional task, project, environment, agent, state, archive, and
cursor filters. Read-only.

#### `get_task_execution`

Arguments: `executionId`, optional transcript/activity limit and cursor.

Returns identity, state, fresh evidence, activities, current attention request,
workspace, executor binding, and delivery summary. Read-only.

#### `wait_task_execution`

Arguments: one or more execution IDs, per-execution cursors, and bounded
timeout.

Returns when an execution completes, fails, becomes uncertain, or requires
approval/input. Commentary/progress events update cursors but need not wake
every wait. Read-only.

#### `send_task_execution_message`

Arguments: `executionId`, message, `operationId`, optional wait behavior.

Rejected while an incompatible active turn exists. Write scope; idempotent.

#### `respond_task_execution_approval`

Arguments: exact execution, turn, request, and item identities; decision; and
`operationId`.

No default approval is invented. The response is rejected if the pending
request changed or disappeared. Write scope; consequential.

#### `respond_task_execution_input`

Arguments: exact execution, turn, request, question IDs, answers, and
`operationId`.

Answers must match the currently pending questions exactly. Write scope.

#### `cancel_task_execution`

Arguments: `executionId`, `operationId`, optional reason.

Interrupts the current agent turn, prevents new work, releases capacity only
after positive terminal evidence, and preserves the workspace unless cleanup
policy is separately authorized. Write scope; idempotent.

#### `archive_task_execution`

Arguments: `executionId`, `operationId`.

Allowed only for terminal executions. Archiving hides normal inventory but does
not delete audit, handoff, operation, workspace, or delivery evidence.

### Shell and repair

#### `start_shell_command`

Arguments:

```ts
interface StartShellCommandInput {
  environmentId: string;
  executionId?: string;
  command: string;
  scope?: 'workspace' | 'environment-recovery';
  timeoutSeconds?: number;
  operationId: string;
}
```

The default `workspace` scope resolves the exact Runner Workspace from
`executionId`; callers do not provide a raw working-directory path. The command
runs asynchronously and returns a command ID.

`environment-recovery` is a separate privileged path for repairing a sandbox
when the normal connector is unavailable. It requires explicit approval,
provider support, complete audit, a bounded lifetime, and an exact Environment.
For Codespaces this may use the provider's authenticated recovery/SSH channel.
It must not silently fall back to executing on the Project Space Hub.

#### `get_shell_command`

Arguments: `commandId`, optional output cursor.

Returns queued/running/completed/failed/cancelled/uncertain state, exit code,
bounded stdout/stderr chunks, truncation markers, timing, target evidence, and
audit reference. Read-only.

#### `cancel_shell_command`

Arguments: `commandId`, `operationId`.

Cancels the exact process group or provider command and reports confirmed or
uncertain termination. Write scope; idempotent.

An interactive TTY can be added later with explicit open, read, input, resize,
and close tools. One-shot asynchronous commands are the first implementation
because they fit MCP retries and audit more reliably.

### Delivery and completion

#### `get_task_delivery_status`

Arguments: `taskId` or `executionId`.

Returns branch, exact commit, pull request, review revision, required checks,
preview, merge, release, deploy, running commit, health, and rollback evidence.
Read-only.

#### `create_or_update_task_pull_request`

Arguments: `executionId`, title/body or generated delivery summary,
draft/ready state, and `operationId`.

Reconciles an existing PR before creating another. Write scope; idempotent.

#### `request_task_review`

Arguments: `executionId`, current pull-request revision, summary, and
`operationId`.

Records the exact revision presented for approval. Any later commit consumes
that approval and returns the execution to review-required.

#### `merge_task_pull_request`

Arguments: `executionId`, expected head commit, expected approved revision,
merge method, and `operationId`.

Requires current-revision approval, green required checks, no unresolved review
gate, and exact head identity. A lost merge response is reconciled before any
retry. Consequential write scope.

#### `complete_task`

Arguments: `taskId`, `executionId`, completion policy, evidence references, and
`operationId`.

Closes or completes the provider Task only after the configured delivery policy
is satisfied. Repository-only work may require merged-commit evidence. A
deployed service may additionally require running-commit, version, health, and
reachable-origin evidence. Write scope; idempotent.

## Shell security boundary

The existing `terminal.run` contract is not suitable for direct MCP exposure.
It accepts a connector/machine ID and arbitrary shell string, has no command
operation ledger, no connector-generation binding, no signed command grant,
no durable cancellation, and no workspace identity.

The replacement must enforce:

1. The signed grant binds user, Environment, connector generation or provider
   recovery channel, execution/workspace, command digest, scope, operation ID,
   request ID, expiry, and maximum output/time.
2. Grants are one-time and replay protected.
3. Workspace scope executes under an OS-enforced workspace sandbox. String
   validation alone cannot stop `cd`, symlink, subprocess, or interpreter
   escapes.
4. Connector registration credentials, Project Space signing material, OAuth
   tokens, service-account tokens, and unrelated environment secrets are not
   inherited by the child process.
5. Output is bounded, cursor-based, and passed through safe secret redaction.
   Redaction is defense in depth, not authorization.
6. Environment-recovery commands require explicit user approval and are never
   selected automatically from a normal workspace command.
7. Commands never execute on the hosted Project Space process merely because a
   target is offline or unresolved.
8. Command activity is retained with actor, target, scope, digest, timing,
   outcome, and correlation ID without recording secret input.

## Authorization and MCP scopes

The current MCP OAuth uses broad read and write scopes. The first additive
implementation may continue honoring them, but the target scope model is:

| Scope | Capabilities |
| --- | --- |
| `project-space.read` | discovery, status, transcripts, evidence |
| `project-space.task.write` | create/update/comment Tasks and Handoffs |
| `project-space.environment.manage` | provision/start/stop Environments |
| `project-space.environment.delete` | destructive Environment deletion |
| `project-space.agent.authorize` | start/cancel agent device login |
| `project-space.execution.write` | start/message/cancel/archive executions |
| `project-space.execution.approve` | answer exact agent approval requests |
| `project-space.shell.workspace` | sandboxed workspace commands |
| `project-space.shell.recovery` | privileged provider recovery commands |
| `project-space.delivery.write` | PR creation/update |
| `project-space.delivery.merge` | approved exact-revision merge |

Tool annotations must truthfully declare read-only, idempotent, destructive,
and open-world behavior. Possession of a broad OAuth token does not bypass
Project Space membership, provider authorization, task policy, approval gates,
or environment-level access.

## UI and MCP truth rules

The Web UI and MCP result for the same operation must be projections of the
same stored state and evidence.

Required implications:

```text
UI says Environment ready
=> MCP get_execution_environment returns fresh readiness evidence

MCP starts Task Execution
=> Web UI can open the same executionId

UI shows Codex authorized
=> fresh account-read evidence exists for that Environment

MCP reports Task completed
=> completion policy evidence exists and references exact revisions

UI or MCP offers delete Environment
=> no active or uncertain execution/workspace dependency exists
```

Disallowed states:

- a stopped Codespace displayed as a broken physical machine;
- a connector displayed as an Environment or Host;
- an old login flag displayed as current authorization;
- an unverified provider create treated as absent and retried into a duplicate;
- two Codespaces silently selected for one task and branch;
- a Codex final answer treated as proof of commit, PR, merge, or deployment;
- a green workflow on an older commit treated as evidence for the current PR;
- an MCP shell command executed on the Hub because its target is unavailable;
- a task closed before its configured delivery evidence exists.

## Persistence model

The database needs durable records for:

- `task_handoffs`, immutable `task_handoff_revisions`, artifact metadata, and
  owner-scoped verified artifact blobs;
- `task_executions`;
- `task_execution_events` with monotonic cursors;
- `task_execution_bindings` for agent-specific identities;
- `runner_workspaces` and exact repository/branch/commit ownership;
- `execution_operations` with fingerprint, result, and reconciliation state;
- `environment_provider_bindings` for provider resource identity and lifecycle;
- `agent_authorization_operations`;
- `shell_commands` and output cursors;
- `task_delivery_evidence` and exact revision relationships;
- `capacity_leases`.

Sensitive provider or agent credentials stay in their existing protected stores
or on the target Environment. These tables store opaque references and
sanitized evidence only.

### Task execution retention and archive policy

- Handoff revisions and artifact metadata are append-only. Archiving a Handoff
  removes it from normal selection but never changes a revision already used by
  an execution.
- A Task Execution may be archived only after it reaches `completed`, `failed`,
  or `cancelled`. Its events, exact handoff revision, executor binding, workspace
  metadata, and source relationships remain available as audit history.
- Completed or blocked operation-ledger results are retained for 30 days after
  their last transition and may then be pruned in bounded batches. Reserved,
  dispatched, confirmed-in-progress, and uncertain operations are never removed
  by age alone; they must reconcile first so expiry cannot permit duplicate work.
- Capacity leases expire automatically after at most 24 hours unless renewed.
  Released and expired lease records remain audit evidence; only one active
  lease may exist for an owner and Environment.
- These storage tables contain opaque artifact references and sanitized results,
  not credentials, device codes, transcripts, raw workspace paths, or
  unrestricted URLs. Rows use restrictive foreign keys rather than cascading
  deletion.

## Provider and executor extension boundaries

### Environment provider adapter

```ts
interface ExecutionEnvironmentProvider {
  kind: string;
  capabilities: {
    provision: boolean;
    start: boolean;
    stop: boolean;
    delete: boolean;
    recoveryShell: boolean;
  };
  provision(actor: ActorRef, request: ProvisionRequest): Promise<ProviderResult>;
  status(actor: ActorRef, binding: ProviderBinding): Promise<ProviderResult>;
  start(actor: ActorRef, binding: ProviderBinding, operation: OperationRef): Promise<ProviderResult>;
  stop(actor: ActorRef, binding: ProviderBinding, operation: OperationRef): Promise<ProviderResult>;
  delete(actor: ActorRef, binding: ProviderBinding, operation: OperationRef): Promise<ProviderResult>;
}
```

GitHub Codespaces is the first adapter. A future generic cloud sandbox or Azure
provider implements the same normalized contract while retaining native state
under its provider projection.

### Agent executor adapter

```ts
interface TaskExecutorAdapter {
  kind: string;
  inspectRuntime(target: ExecutionTarget): Promise<AgentRuntimeEvidence>;
  inspectAuthorization(target: ExecutionTarget): Promise<AgentAuthorizationEvidence>;
  startAuthorization(request: AgentAuthorizationRequest): Promise<AgentAuthorizationResult>;
  startExecution(request: ExecutorStartRequest): Promise<ExecutorBindingResult>;
  read(binding: ExecutorBinding, cursor?: string): Promise<ExecutionActivityPage>;
  send(binding: ExecutorBinding, request: ExecutorMessageRequest): Promise<OperationResult>;
  cancel(binding: ExecutorBinding, request: ExecutorCancelRequest): Promise<OperationResult>;
}
```

The Codex adapter wraps the existing App Server, thread, turn, approval, input,
browser, and operation-ledger implementation. A future Claude adapter must not
modify neutral task or environment records.

## Implementation work packages

### WP0 — stabilize shared Codespaces runtime

Owner dependency: Issue #456 / PR #529. The shared Codespaces runtime contract
and subsequent fixes are merged and production-delivered. The final item remains
open until the real production UI-to-Codespace-to-ChatGPT-to-PR proof completes.

- [x] Keep `src/shared/github-codespace-runner-api.ts` UI-independent.
- [x] Keep `server/github-codespace-runner/service.ts` pure and reusable.
- [x] Extract the configured GitHub/OAuth/lock/inventory adapter into
      `server/github-codespace-runner/configured-runtime.ts`.
- [x] Make the Web UI HTTP handler a thin validator and presenter.
- [x] Export `createConfiguredGitHubCodespaceRunnerRuntime({ backend })` for
      in-process use through `GitHubCodespaceRunnerRuntime.run(request)`.
- [x] Retain duplicate and uncertain-create reconciliation behavior.
- [ ] Complete real production Codespaces E2E proof from UI through agent PR.

### WP1 — expose canonical compute inventory through MCP

- [x] Add `list_execution_environments` and `get_execution_environment`.
- [x] Return Platform, optional Host, Environment, connector association,
      resources, lifecycle evidence, runtime, authorization, and capacity.
- [x] Sanitize provider and connector identity data for remote clients.
- [x] Add `environmentId` to current Codex compatibility tools.
- [x] Deprecate `list_machines` without removing it.
- [x] Test hostless Codespaces, nested WSL/devbox, multiple connectors, stale
      connector generation, conflict, unresolved, and not-applicable Host state.

### WP2 — add Environment lifecycle MCP tools

- [x] Add provision, start, stop, and delete tools.
- [x] Route GitHub Codespaces through the shared PR #529 configured runtime.
- [x] Persist provider binding and operation results.
- [x] Normalize lifecycle while retaining provider-native evidence.
- [x] Reconcile uncertain create/start/stop/delete responses.
- [x] Enforce no-active-execution stop/delete gates.
- [x] Add Codespaces OAuth scope and provider reauthorization results to MCP.

### WP3 — add agent runtime and authorization tools

- [x] Expose agent runtime/status by `environmentId`.
- [x] Expose start/status/cancel for Codex device authorization.
- [x] Return verification URL and user code without credentials.
- [x] Poll `account/read` for actual readiness.
- [x] Reject API-key fallback in managed Environments.
- [x] Test fresh, already-ready, denied, cancelled, expired, connector restart,
      and ambiguous login outcomes.

### WP4 — introduce Handoff and Task Execution storage

- [x] Add immutable Handoff revisions and artifact references.
- [x] Add neutral Task Execution identity and event cursor.
- [x] Move Codex thread identity under executor binding.
- [x] Store exact Environment, connector generation, workspace, handoff revision,
      task, repository, branch, and commit relationships.
- [x] Add a durable operation ledger and capacity lease.
- [x] Define retention and archive policy.

### WP5 — implement generic execution MCP tools

- [x] Add start/list/get/wait/message/cancel/archive.
- [x] Add exact approval and input response tools.
- [x] Make normal start own environment start, readiness, authorization block,
      worktree preparation, and executor start.
- [x] Preserve current `start_codex_task`, `read_codex_task`,
      `send_codex_message`, and `list_codex_tasks` as aliases.
- [x] Add a client-independent structured result schema and pagination.

### WP6 — structured cross-orchestrator handoff

- [x] Add create/get/update-execution-handoff tools.
- [x] Support referenced designs, documents, screenshots, and decisions.
- [x] Verify artifact digest, access, size, and provenance.
- [x] Make a Claude-produced design consumable by Codex without local-path
      assumptions.
- [x] Record explicit mode and permissions separately from descriptive context.

### WP7 — safe shell and recovery

- [ ] Replace direct MCP exposure of legacy `terminal.run` with asynchronous
      command storage and signed grants.
- [ ] Add workspace-scoped start/get/cancel tools.
- [ ] Resolve cwd through execution/workspace identity, not a browser path.
- [ ] Run with a sanitized environment and OS-enforced workspace isolation.
- [ ] Add output cursors, limits, cancellation, audit, and uncertainty.
- [ ] Add a separately approved provider recovery path for a broken Codespace
      connector.
- [ ] Prove commands never run on the Hub as fallback.

### WP8 — pull-request delivery and completion

- [ ] Compose branch, PR, checks, review, merge, deploy, and health evidence.
- [ ] Add PR create/update and review-request tools.
- [ ] Bind approval to the exact PR revision.
- [ ] Add guarded merge and uncertain-merge reconciliation.
- [ ] Add policy-driven `complete_task`.
- [ ] Verify exact deployed commit, running version, health, and reachable origin
      where the project requires deployment.

### WP9 — production E2E and provider extension

- [ ] Run a persistent connector-backed task from MCP through PR.
- [ ] Run a fresh Codespaces task from MCP through device login and PR.
- [ ] Stop and resume the Codespace without duplicating identities.
- [ ] Exercise workspace repair and approved provider recovery.
- [ ] Exercise approval, input, cancellation, uncertain provider response, and
      archive.
- [ ] Merge an approved test revision and verify configured delivery evidence.
- [ ] Document the adapter contract for Azure DevOps and another agent runtime
      without implementing them yet.

## Dependency order

```text
WP0 shared Codespaces runtime
  -> WP1 canonical Environment inventory
  -> WP2 Environment lifecycle
  -> WP3 agent authorization
  -> WP4 durable Handoff and Task Execution
  -> WP5 generic execution tools
  -> WP6 cross-orchestrator Handoff
  -> WP7 safe shell and recovery
  -> WP8 delivery and completion
  -> WP9 production E2E and extension proof
```

WP6 artifact design can proceed alongside WP4. WP7 command infrastructure can
proceed alongside WP5 after the Environment, connector-generation, operation,
and workspace identities are stable. Delivery work can reuse existing GitHub
status APIs but must wait for Task Execution identity and exact revision
evidence.

## Verification matrix

| Layer | Required proof |
| --- | --- |
| Domain types | Runtime validators reject unknown fields, mismatched identities, invalid transitions, and unsupported provider/agent kinds |
| Operation ledger | Same ID/same input replays; same ID/different input conflicts; uncertain outcome reconciles |
| Compute inventory | Hostless Codespace, physical Host, nested WSL/devbox, multiple connectors, conflicts, stale reports |
| Provider service | Provision/start/stop/delete/status, duplicates, pagination, rate limit, uncertain create, provider auth |
| Connector | Signed grant, generation fencing, revoke, reconnect, capability freshness, output limits |
| Agent auth | required, pending, ready, denied, cancelled, expired, ambiguous, restart, no API-key fallback |
| Workspace | exact repository, branch, commit, path classification, ownership, collision, broken registration |
| Execution | start, replay, block/resume, message, approval, input, cancel, wait cursor, archive |
| Handoff | immutable revision, artifact digest/access, explicit update, executor receives exact revision |
| Shell | workspace isolation, sanitized environment, cancel, timeout, truncation, secret safety, recovery approval |
| Delivery | PR reconciliation, current commit checks, revision approval invalidation, merge reconciliation, deploy evidence |
| MCP protocol | OAuth scopes, Streamable HTTP session reuse, structured content, tool annotations, safe errors, request IDs |
| Web/MCP parity | Same operation and execution IDs, states, evidence, attention requests, and links in both clients |
| Production E2E | Fresh Codespace login and task through PR; persistent Environment task through PR; no duplicate identities |

Tests should include connector disconnects and restarts at every mutation
boundary. A mocked green path alone is insufficient for production delivery.

## Rollout and compatibility

1. Add new types, storage, services, and tools without removing current tools.
2. Teach the Web UI and MCP to read the same Environment and Task Execution
   records.
3. Add compatibility adapters from physical-machine selectors to
   `environmentId` only where the mapping is exact.
4. Emit deprecation metadata and documentation for old machine/Codex names.
5. Move internal UI callers to generic services.
6. Dogfood both persistent and Codespaces execution from production.
7. Remove legacy aliases only after remote MCP clients, CLI, Web UI, and stored
   records have migrated and an announced compatibility window has elapsed.

No migration may reinterpret an existing connector ID as an Environment ID or
physical Host ID. Compatibility results can project old shapes, but identity
semantics remain immutable.

## Definition of complete

The architecture is implemented only when a supported MCP client can:

1. discover a Task;
2. create or select an exact structured Handoff revision;
3. select a persistent Environment or provision a Codespace;
4. start the Environment and observe honest readiness;
5. complete Codex ChatGPT-subscription device authorization without entering
   the sandbox terminal;
6. start exactly one durable Task Execution in an exact Runner Workspace;
7. observe, message, approve, answer, cancel, or repair it;
8. receive verified implementation and test evidence;
9. create or update one pull request;
10. wait for current-revision CI and review;
11. merge only after current-revision approval;
12. verify the configured delivery and live state;
13. complete the provider Task;
14. stop, retain, or delete the Environment according to explicit policy; and
15. archive the execution without losing its audit history.

The same execution, environment, operation, handoff, workspace, and delivery
identities must be visible in the Web UI. No normal Codespaces step may require
opening the Codespace terminal, and no MCP implementation may duplicate the
provider logic already used by the Web UI.
