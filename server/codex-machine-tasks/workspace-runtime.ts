import { createHash } from 'node:crypto';

import type {
  CodexSessionContinueRequest,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionStartResult,
  CodexSessionStreamEvent
} from '../../src/shared/codex-sessions-api';
import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
import { builtInEnvironmentDefinition } from '../../src/shared/compute-environment-api';
import type { MachineRecord, PhysicalMachineRecord } from '../../src/shared/project-space-api';
import type { WorkspaceRuntimeCodexCommand, WorkspaceRuntimeCodexMessage } from '../../src/shared/workspace-runtime-codex-api';
import type { WorkspaceRuntimeSessionService } from '../workspace-runtime-session/service';
import { generationNumber } from '../workspace-runtime-codex-host/validation';

type RuntimeSnapshot = Awaited<ReturnType<WorkspaceRuntimeSessionService['list']>>[number];

export interface WorkspaceRuntimeCodexBridge {
  inventory(userId: string): Promise<{
    computeInventory: ComputeInventorySnapshot;
    connectors: MachineRecord[];
    physicalMachines: PhysicalMachineRecord[];
    runtimeStatuses: ReadonlyMap<string, {
      capabilities: string[];
      machineId: string;
      online: boolean;
      update: { state: 'up-to-date' };
    }>;
  }>;
  generationFor(machineId: string): number | undefined;
  plan(input: {
    branch: string;
    commit: string;
    connectorId: string;
    generation: number;
    issue: { number: number; url: string };
    operationId: string;
    physicalMachineId: string;
    repository: { id: string; nameWithOwner: string };
    userId: string;
  }): Promise<{
      plan?: {
        environment: { id: string; name: string };
      workspace: { branch: string; commit: string; id: string; path?: string };
        worktree?: { branch: string; id: string };
    };
    state: 'ready' | 'uncertain' | 'unavailable';
    message?: string;
  }>;
  start(input: {
    branch: string;
    commit: string;
    connectorId: string;
    generation: number;
    issue: { number: number; url: string };
    operationId: string;
    physicalMachineId: string;
    repository: { id: string; nameWithOwner: string };
    userId: string;
  }): Promise<{
    generation: number;
    result:
      | {
          state: 'confirmed';
          handoff: { state: 'accepted'; turnId: string };
          threadId: string;
          workspace: {
            branch: string;
            commit: string;
            id: string;
            path?: string;
            worktree?: { branch: string; id: string };
          };
          worktreeId: string;
        }
      | { message: string; state: 'worktree_failure' }
      | { state: 'offline' | 'uncertain' };
  }>;
  sessions: {
    read(input: { connectorId: string; generation: number; threadId: string; userId: string }): Promise<CodexSessionReadResult>;
    send(input: { connectorId: string; delivery: 'new-turn' | 'steer'; expectedTurnId?: string; generation: number; message: string; operationId: string; threadId: string; userId: string }): Promise<CodexSessionOperationResult>;
    reconcileSend?(input: { connectorId: string; delivery: 'new-turn' | 'steer'; expectedTurnId?: string; generation: number; message: string; operationId: string; threadId: string; userId: string }): Promise<{ generation: number; result: CodexSessionOperationResult }>;
    stream(input: { connectorId: string; generation: number; threadId: string; userId: string; afterSequence?: number; emit: (event: CodexSessionStreamEvent, sequence?: number) => void; signal: AbortSignal; onReady?: () => void }): Promise<void>;
    wait(input: { connectorId: string; generation: number; threadId: string; userId: string; start: () => Promise<CodexSessionOperationResult>; afterSequence?: number }): Promise<{ event?: CodexSessionStreamEvent; result: CodexSessionOperationResult; sequence?: number }>;
  };
}

/**
 * Adapts the canonical outbound Workspace Runtime Codex channel to the old
 * service shape while keeping Environment and Workspace Runtime as the only
 * selectors. The connector-shaped values produced here are private
 * compatibility projections and are never accepted as request selectors.
 */
export function createWorkspaceRuntimeCodexBridge(options: {
  loadInventory(userId: string): Promise<ComputeInventorySnapshot>;
  sessions: WorkspaceRuntimeSessionService;
  resolveWorkspaceBinding?(input: {
    branch: string;
    commit: string;
    environmentId: string;
    ownerUserId: string;
    workspaceId: string;
  }): Promise<{
    branch: string;
    commit: string;
    id: string;
    path?: string;
    worktree?: { branch: string; id: string };
  } | undefined>;
}) : WorkspaceRuntimeCodexBridge {
  const generations = new Map<string, number>();
  const sequences = new Map<string, { generation: string; sequence: number }>();

  async function runtime(userId: string, machineId: string) {
    const snapshots = await options.sessions.list(userId);
    const snapshot = snapshots.find((candidate) => runtimeMachineId(candidate) === machineId);
    if (!snapshot || snapshot.connectionState !== 'online' ||
        !snapshot.capabilities.includes('runtime.codex.v1')) {
      throw new Error('The selected Workspace Runtime Codex capability is unavailable.');
    }
    snapshotOwnerByWorkspace.set(snapshot.workspaceId, userId);
    generations.set(machineId, generationNumber(snapshot.generation));
    return snapshot;
  }

  function commandBase(snapshot: RuntimeSnapshot, operationId: string, sequence: number, threadId?: string) {
    return {
      actorId: snapshot.workspaceId,
      actorKind: 'human' as const,
      actorUserId: snapshotOwner(snapshot),
      commandId: operationId,
      commandSequence: sequence,
      environmentId: snapshot.environmentId,
      generation: snapshot.generation,
      operationId,
      schemaVersion: 1 as const,
      sessionId: snapshot.sessionId,
      ...(threadId ? { targetThreadId: threadId } : {}),
      workspaceId: snapshot.workspaceId
    };
  }

  async function dispatch<Result>(
    userId: string,
    snapshot: RuntimeSnapshot,
    operationId: string,
    kind: WorkspaceRuntimeCodexCommand['kind'],
    request: WorkspaceRuntimeCodexCommand['request'],
    threadId?: string
  ): Promise<Result> {
    const key = `${userId}\0${snapshot.workspaceId}`;
    const authoritative = snapshot.codexAcceptedCommandSequence;
    if (authoritative === undefined) {
      throw new Error('The Workspace Runtime Codex command sequence is unavailable.');
    }
    const prior = sequences.get(key);
    const state = !prior || prior.generation !== snapshot.generation
      ? { generation: snapshot.generation, sequence: authoritative }
      : { generation: prior.generation, sequence: Math.max(prior.sequence, authoritative) };
    const sequence = state.sequence + 1;
    state.sequence = sequence;
    sequences.set(key, state);
    const command = {
      ...commandBase(snapshot, operationId, sequence, threadId), kind, request,
      type: 'runtime.codex.command' as const
    } as WorkspaceRuntimeCodexCommand;
    return new Promise<Result>((resolve, reject) => {
      const timeout = setTimeout(() => {
        remove();
        reject(new Error('Workspace Runtime Codex response timed out.'));
      }, 30_000);
      const listener = async (message: WorkspaceRuntimeCodexMessage) => {
        if (message.operationId !== operationId || message.sessionId !== snapshot.sessionId) return;
        if (message.type === 'runtime.codex.result') {
          clearTimeout(timeout); remove(); resolve(message.result as Result);
        } else if (message.type === 'runtime.codex.error') {
          clearTimeout(timeout); remove(); reject(new Error(message.message));
        }
      };
      const remove = options.sessions.onCodexMessage(listener);
      try {
        options.sessions.dispatchCodex(userId, command);
      } catch (error) {
        clearTimeout(timeout); remove(); reject(error);
      }
    });
  }

  function snapshotOwner(snapshot: RuntimeSnapshot) {
    // The session service only returns owner-scoped snapshots. The caller is
    // bound again by dispatchCodex, so this value is replaced by the caller.
    return snapshotOwnerByWorkspace.get(snapshot.workspaceId) ?? 'unknown-owner';
  }
  const snapshotOwnerByWorkspace = new Map<string, string>();

  async function planBinding(input: {
    branch: string;
    commit: string;
    connectorId: string;
    generation: number;
    issue: { number: number; url: string };
    operationId: string;
    physicalMachineId: string;
    repository: { id: string; nameWithOwner: string };
    userId: string;
  }) {
    try {
      const snapshot = await runtime(input.userId, input.connectorId);
      if (snapshot.branch !== input.branch || snapshot.commit.toLowerCase() !== input.commit.toLowerCase()) {
        return {
          message: 'The Workspace Runtime is attached to a different branch or commit.',
          state: 'uncertain' as const
        };
      }
      let workspace: {
        branch: string;
        commit: string;
        id: string;
        path?: string;
        worktree?: { branch: string; id: string };
      } = {
        branch: snapshot.branch,
        commit: snapshot.commit,
        id: snapshot.workspaceId
      };
      if (!options.resolveWorkspaceBinding) {
        return {
          message: 'The Project-managed workspace/worktree binding is unavailable.',
          state: 'unavailable' as const
        };
      }
      const resolved = await options.resolveWorkspaceBinding({
        branch: input.branch,
        commit: input.commit,
        environmentId: snapshot.environmentId,
        ownerUserId: input.userId,
        workspaceId: snapshot.workspaceId
      });
      if (!resolved || resolved.id !== snapshot.workspaceId || resolved.branch !== snapshot.branch ||
          resolved.commit.toLowerCase() !== snapshot.commit.toLowerCase()) {
        return {
          message: 'The Project-managed workspace/worktree binding is unavailable.',
          state: 'unavailable' as const
        };
      }
      workspace = resolved;
      return {
        plan: {
          environment: { id: snapshot.environmentId, name: snapshot.presentation?.repository ?? snapshot.environmentId },
          workspace: { branch: workspace.branch, commit: workspace.commit, id: workspace.id, ...(workspace.path ? { path: workspace.path } : {}) },
          ...(workspace.worktree ? { worktree: workspace.worktree } : {})
        },
        state: 'ready' as const
      };
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : 'The Workspace Runtime is unavailable.',
        state: /unavailable|offline/i.test(error instanceof Error ? error.message : '')
          ? 'unavailable' as const
          : 'uncertain' as const
      };
    }
  }

  return {
    async inventory(userId) {
      const base = await options.loadInventory(userId);
      const computeInventory: ComputeInventorySnapshot = {
        ...base,
        connectors: [...base.connectors],
        environmentDefinitions: [...base.environmentDefinitions],
        environments: [...base.environments],
        hosts: [...base.hosts],
        platforms: [...base.platforms],
        violations: [...base.violations]
      };
      const snapshots = await options.sessions.list(userId);
      const connectors: MachineRecord[] = [];
      const physicalMachines: PhysicalMachineRecord[] = [];
      const runtimeStatuses = new Map<string, {
        capabilities: string[]; machineId: string; online: boolean; update: { state: 'up-to-date' }
      }>();
      const environmentIds = new Set(computeInventory.environments.map(({ id }) => id));
      for (const snapshot of snapshots) {
        snapshotOwnerByWorkspace.set(snapshot.workspaceId, userId);
        const machineId = runtimeMachineId(snapshot);
        const online = snapshot.connectionState === 'online' && snapshot.lifecycleState === 'running';
        generations.set(machineId, generationNumber(snapshot.generation));
        connectors.push(syntheticConnector(machineId, snapshot, online));
        physicalMachines.push({ connectorIds: [machineId], id: snapshot.environmentId, name: snapshot.environmentId });
        runtimeStatuses.set(machineId, {
          capabilities: ['codex.machine-tasks.v1'], machineId, online, update: { state: 'up-to-date' }
        });
        if (!environmentIds.has(snapshot.environmentId)) {
          computeInventory.environments = [...computeInventory.environments, syntheticEnvironment(snapshot)];
          computeInventory.environmentDefinitions = [...computeInventory.environmentDefinitions, {
            ...builtInEnvironmentDefinition('other'), id: 'workspace-runtime-other'
          }];
          computeInventory.platforms = [...computeInventory.platforms, { id: 'workspace-runtime', kind: 'local', name: 'Workspace Runtime' }];
          environmentIds.add(snapshot.environmentId);
        }
        computeInventory.connectors = [...computeInventory.connectors, {
          associatedAt: snapshot.lastEventAt,
          connectorId: machineId,
          environmentId: snapshot.environmentId
        }];
      }
      return { computeInventory, connectors, physicalMachines, runtimeStatuses };
    },
    generationFor(machineId) { return generations.get(machineId); },
    plan: planBinding,
    async start(input) {
      try {
        const planned = await planBinding(input);
        if (planned.state === 'unavailable') {
          if (!planned.message?.includes('workspace/worktree binding')) {
            return { generation: input.generation, result: { state: 'offline' } };
          }
          return {
            generation: input.generation,
            result: {
              message: planned.message ?? 'The Project-managed workspace/worktree binding is unavailable.',
              state: 'worktree_failure'
            }
          };
        }
        if (planned.state !== 'ready' || !planned.plan?.worktree) {
          return {
            generation: input.generation,
            result: {
              message: planned.message ?? 'The Project-managed workspace/worktree binding is unavailable.',
              state: 'worktree_failure'
            }
          };
        }
        const snapshot = await runtime(input.userId, input.connectorId);
        const result = await dispatch<CodexSessionStartResult>(
          input.userId, snapshot, input.operationId, 'start',
          {
            cwd: '.',
            handoff: {
              branch: input.branch,
              commit: input.commit,
              environmentId: snapshot.environmentId,
              issue: input.issue,
              repository: input.repository,
              workspaceId: planned.plan.workspace.id,
              worktreeId: planned.plan.worktree.id
            },
            machineId: input.connectorId,
            operationId: input.operationId
          }
        );
        if (!result.initialTurnId) {
          return {
            generation: generationNumber(snapshot.generation),
            result: { state: 'uncertain' }
          };
        }
        return {
          generation: generationNumber(snapshot.generation),
          result: {
            state: 'confirmed',
            handoff: { state: 'accepted', turnId: result.initialTurnId },
            threadId: result.threadId,
            workspace: planned.plan.workspace,
            worktreeId: planned.plan.worktree.id
          }
        };
      } catch (error) {
        return {
          generation: input.generation,
          result: { state: error instanceof Error && /unavailable|offline/i.test(error.message) ? 'offline' : 'uncertain' }
        };
      }
    },
    sessions: {
      async read(input) {
        const snapshot = await runtime(input.userId, input.connectorId);
        return dispatch<CodexSessionReadResult>(input.userId, snapshot, `read:${input.threadId}`, 'read', {
          machineId: input.connectorId, threadId: input.threadId
        }, input.threadId);
      },
      async send(input) {
        const snapshot = await runtime(input.userId, input.connectorId);
        return dispatch<CodexSessionOperationResult>(input.userId, snapshot, input.operationId, 'continue', {
          delivery: input.delivery, expectedTurnId: input.expectedTurnId, machineId: input.connectorId,
          message: input.message, operationId: input.operationId, threadId: input.threadId
        } as CodexSessionContinueRequest, input.threadId);
      },
      async reconcileSend(input) {
        return { generation: input.generation, result: await this.send(input) };
      },
      async stream(input) {
        const snapshot = await runtime(input.userId, input.connectorId);
        input.onReady?.();
        await dispatch<{ state: 'streaming' }>(input.userId, snapshot, `stream:${input.threadId}`, 'stream-start', {
          afterSequence: input.afterSequence, machineId: input.connectorId, threadId: input.threadId
        }, input.threadId);
        if (!input.signal.aborted) await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      },
      async wait(input) {
        return { result: await input.start() };
      }
    }
  };
}

function runtimeMachineId(snapshot: Pick<RuntimeSnapshot, 'workspaceId' | 'environmentId' | 'generation'>) {
  const digest = createHash('sha256').update([
    snapshot.workspaceId, snapshot.environmentId
  ].join('\0')).digest('hex').slice(0, 32);
  return `workspace-runtime:${digest}`;
}

function syntheticConnector(id: string, snapshot: RuntimeSnapshot, online: boolean) {
  return {
    connector: {
      capabilities: ['codex.machine-tasks.v1'],
      installCommand: '',
      runtime: undefined,
      status: online ? 'online' : 'offline'
    },
    id,
    kind: 'workspace-runtime',
    name: `Workspace ${snapshot.workspaceId}`,
    network: {},
    roles: [],
    sourcePath: 'workspace-runtime'
  } as unknown as MachineRecord;
}

function syntheticEnvironment(snapshot: RuntimeSnapshot) {
  return {
    environmentDefinitionId: 'workspace-runtime-other',
    hostAssociation: { evidence: 'none' as const, resolution: 'not_applicable' as const },
    id: snapshot.environmentId,
    identity: { key: `environment:${snapshot.environmentId}`, version: 1 },
    kind: 'other' as const,
    name: snapshot.environmentId,
    platformId: 'workspace-runtime',
    resourceMode: 'dedicated' as const
  };
}
