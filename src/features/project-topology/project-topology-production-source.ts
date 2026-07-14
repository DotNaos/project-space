import type { CodexSessionsClient } from '@/shared/codex-sessions-api';
import type {
  ProjectSpaceBackend,
  ProjectWorktreeDiscoveryResult
} from '@/shared/project-space-api';
import type {
  ProjectTopologySource,
  ProjectTopologySourceResult
} from './project-topology-loader';
import type {
  TopologyTaskEvidence,
  TopologyTaskLocationEvidence,
  TopologyTaskWriteCapability
} from './project-topology-types';

type ProjectTopologyProjectClient = Pick<
  ProjectSpaceBackend,
  | 'getConnectorOverview'
  | 'getDeployedEnvironmentStatus'
  | 'getGitHubRepositoryDetails'
  | 'loadProjectDiscovery'
> & {
  discoverProjectWorktrees(
    projectId: string,
    machineId?: string
  ): Promise<ProjectWorktreeDiscoveryResult>;
};

export interface ProjectTopologyProductionCapabilities {
  getTaskEvidence?(
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<TopologyTaskEvidence>;
  getWriteCapability?(
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<TopologyTaskWriteCapability>;
  resolveTaskLocation?(
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<TopologyTaskLocationEvidence>>;
}

export interface ProjectTopologyProductionSourceOptions {
  capabilities?: ProjectTopologyProductionCapabilities;
  clock?: () => string;
  codex: CodexSessionsClient;
  projectSpace: ProjectTopologyProjectClient;
}

export function createProjectTopologyProductionSource(
  options: ProjectTopologyProductionSourceOptions
): ProjectTopologySource {
  const clock = options.clock ?? (() => new Date().toISOString());
  const guarded = <T>(signal: AbortSignal | undefined, load: () => Promise<T>) => (
    guardedSourceCall(signal, load)
  );
  return {
    async discoverProjectWorktrees(projectId, machineId, signal) {
      return guarded(signal, () => options.projectSpace.discoverProjectWorktrees(
        projectId,
        machineId
      ));
    },
    async getConnectorOverview(signal) {
      const data = await guarded(signal, () => options.projectSpace.getConnectorOverview());
      return ready(data, clock());
    },
    async getDeployedEnvironmentStatus(repositoryFullName, signal) {
      const data = await guarded(signal, () => (
        options.projectSpace.getDeployedEnvironmentStatus(repositoryFullName)
      ));
      return ready(data, data.checkedAt);
    },
    async getGitHubRepositoryDetails(repositoryFullName, signal) {
      const data = await guarded(signal, () => (
        options.projectSpace.getGitHubRepositoryDetails(repositoryFullName)
      ));
      return ready(data, data.checkedAt);
    },
    async listCodexSessions(machineId, signal) {
      const data = await guarded(signal, () => options.codex.list({ machineId }));
      return data.machine.online
        ? ready(data, data.checkedAt)
        : {
            checkedAt: data.checkedAt,
            reason: data.machine.statusMessage
              ?? 'Codex task inventory is offline and has no proven last-safe timestamp.',
            state: 'blocked'
          };
    },
    async loadProjectDiscovery(signal) {
      const data = await guarded(signal, () => options.projectSpace.loadProjectDiscovery());
      return ready(data, clock());
    },
    async readCodexSession(machineId, threadId, signal) {
      const data = await guarded(signal, () => options.codex.read({ machineId, threadId }));
      return ready(data, clock());
    },
    async resolveCodexSessionLocation(machineId, threadId, signal) {
      const resolve = options.capabilities?.resolveTaskLocation;
      if (!resolve) {
        return {
          checkedAt: clock(),
          reason: 'Canonical task location is not supported by the current server contract.',
          state: 'blocked'
        };
      }
      return guarded(signal, () => resolve(machineId, threadId, signal));
    },
    ...(options.capabilities?.getWriteCapability ? {
      getCodexSessionWriteCapability(machineId, threadId, signal) {
        return guarded(signal, () => options.capabilities!.getWriteCapability!(
          machineId,
          threadId,
          signal
        ));
      }
    } : {}),
    ...(options.capabilities?.getTaskEvidence ? {
      getCodexSessionTaskEvidence(machineId, threadId, signal) {
        return guarded(signal, () => options.capabilities!.getTaskEvidence!(
          machineId,
          threadId,
          signal
        ));
      }
    } : {})
  };
}

function ready<T>(data: T, checkedAt: string) {
  return { checkedAt, data, state: 'ready' as const };
}

async function guardedSourceCall<T>(
  signal: AbortSignal | undefined,
  load: () => Promise<T>
) {
  throwIfAborted(signal);
  const result = await load();
  throwIfAborted(signal);
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  const error = new Error('Topology source loading was cancelled.');
  error.name = 'AbortError';
  throw error;
}
