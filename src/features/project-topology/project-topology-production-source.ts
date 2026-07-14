import type { CodexSessionsClient } from '@/shared/codex-sessions-api';
import { localizeCodexSessionInventoryWindow } from '../../shared/codex-session-inventory-window';
import type {
  GitHubCatalogResult,
  ProjectDiscoveryResult,
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
import type { ProjectTopologyWorktreeSnapshot } from '../../shared/project-topology-api';
import { maxReadyEvidenceAgeMs } from './project-topology-source-validation';

type ProjectTopologyProjectClient = Pick<
  ProjectSpaceBackend,
  | 'getConnectorOverview'
  | 'getDeployedEnvironmentStatus'
  | 'getGitHubCatalog'
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
  loadProjectWorktreeSnapshot?(
    signal?: AbortSignal
  ): Promise<ProjectTopologyWorktreeSnapshot>;
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
    ...(options.loadProjectWorktreeSnapshot ? {
      async loadProjectWorktreeSnapshot(signal?: AbortSignal) {
        const [snapshot, catalog] = await guarded(signal, () => Promise.all([
          options.loadProjectWorktreeSnapshot!(signal),
          options.projectSpace.getGitHubCatalog().catch(() => undefined)
        ]));
        const receivedAt = clock();
        const localized = localizeWorktreeSnapshot(snapshot, receivedAt);
        return ready({
          ...localized,
          projectDiscovery: joinProjectCatalogIdentity(
            localized.projectDiscovery,
            catalog
          )
        }, localized.checkedAt);
      }
    } : {}),
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
      const startedAt = clock();
      const data = await guarded(signal, () => options.codex.list({ machineId }));
      const receivedAt = clock();
      if (!data.machine.online) return {
        checkedAt: receivedAt,
        reason: data.machine.statusMessage
          ?? 'Codex task inventory is offline and has no proven last-safe timestamp.',
        state: 'blocked'
      };
      const localized = localizeCodexSessionInventoryWindow(data, {
        elapsedMs: Date.parse(receivedAt) - Date.parse(startedAt),
        machineId,
        publishedAt: receivedAt
      });
      if (!localized) return {
        checkedAt: receivedAt,
        reason: 'Codex task inventory returned an invalid acquisition window.',
        state: 'blocked'
      };
      return localized.ageMs <= maxReadyEvidenceAgeMs
        ? ready(localized.inventory, localized.inventory.checkedAt)
        : {
            data: localized.inventory,
            lastSafeAt: localized.inventory.checkedAt,
            reason: 'Codex task inventory expired before it reached the topology.',
            state: 'stale'
          };
    },
    async loadProjectDiscovery(signal) {
      const data = await guarded(signal, async () => {
        const [discovery, catalog] = await Promise.all([
          options.projectSpace.loadProjectDiscovery(),
          options.projectSpace.getGitHubCatalog().catch(() => undefined)
        ]);
        return joinProjectCatalogIdentity(discovery, catalog);
      });
      return ready(data, clock());
    },
    async readCodexSession(machineId, threadId, signal) {
      const data = await guarded(signal, () => options.codex.read({ machineId, threadId }));
      return ready(data, clock());
    },
    async resolveCodexSessionLocation(machineId, threadId, signal) {
      const resolve = options.capabilities?.resolveTaskLocation;
      if (resolve) return guarded(signal, () => resolve(machineId, threadId, signal));
      const inspect = options.codex.inspect;
      if (!inspect) {
        return {
          checkedAt: clock(),
          reason: 'Existing-task inspection is not supported by the current server contract.',
          state: 'blocked'
        };
      }
      const result = await guarded(signal, () => inspect({ machineId, threadId }));
      const receivedAt = clock();
      return ready({ ...result.taskLocation, checkedAt: receivedAt }, receivedAt);
    },
    async getCodexSessionWriteCapability(machineId, threadId, signal) {
      const load = options.capabilities?.getWriteCapability;
      if (load) {
        return guarded(signal, () => load(machineId, threadId, signal));
      }
      const inspect = options.codex.inspect;
      if (!inspect) return {
        checkedAt: clock(),
        reason: 'Existing-task inspection is not supported by the current server contract.',
        state: 'unavailable'
      };
      const result = await guarded(signal, () => inspect({ machineId, threadId }));
      const receivedAt = clock();
      return result.writeCapability
        ? localizeWriteCapability(result.writeCapability, receivedAt)
        : {
        checkedAt: receivedAt,
        reason: 'The server did not issue a current write capability for this Codex task.',
        state: 'unavailable'
      };
    },
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

function localizeWorktreeSnapshot(
  snapshot: ProjectTopologyWorktreeSnapshot,
  receivedAt: string
): ProjectTopologyWorktreeSnapshot {
  const publishedTime = Date.parse(snapshot.publishedAt);
  const receivedTime = Date.parse(receivedAt);
  const localize = (checkedAt: string) => new Date(
    receivedTime - (publishedTime - Date.parse(checkedAt))
  ).toISOString();
  return {
    ...snapshot,
    authorization: {
      connectorOverviewCheckedAt: localize(
        snapshot.authorization.connectorOverviewCheckedAt
      ),
      projectDiscoveryCheckedAt: localize(
        snapshot.authorization.projectDiscoveryCheckedAt
      )
    },
    checkedAt: localize(snapshot.checkedAt),
    publishedAt: receivedAt,
    worktrees: snapshot.worktrees.map((entry) => ({
      ...entry,
      result: entry.result.state === 'blocked'
        ? { ...entry.result, checkedAt: localize(entry.result.checkedAt) }
        : {
            ...entry.result,
            evidence: {
              ...entry.result.evidence,
              checkedAt: localize(entry.result.evidence.checkedAt)
            }
          }
    }))
  };
}

function joinProjectCatalogIdentity(
  discovery: ProjectDiscoveryResult,
  catalog: GitHubCatalogResult | undefined
) {
  if (catalog?.status !== 'connected') return discovery;
  const repositories = new Map(catalog.repositories.map((repository) => [
    repository.fullName.toLowerCase(),
    repository
  ]));
  return {
    ...discovery,
    projects: discovery.projects.map((project) => {
      const repository = project.github
        ? repositories.get(project.github.fullName.toLowerCase())
        : undefined;
      return repository ? { ...project, github: repository } : project;
    })
  };
}

function ready<T>(data: T, checkedAt: string) {
  return { checkedAt, data, state: 'ready' as const };
}

function localizeWriteCapability(
  capability: TopologyTaskWriteCapability,
  receivedAt: string
): TopologyTaskWriteCapability {
  if (capability.state !== 'ready') return { ...capability, checkedAt: receivedAt };
  const duration = Date.parse(capability.expiresAt) - Date.parse(capability.checkedAt);
  const receivedTime = Date.parse(receivedAt);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 30_000 || !Number.isFinite(receivedTime)) {
    return {
      checkedAt: receivedAt,
      reason: 'The server returned an invalid existing-task write window.',
      state: 'unavailable'
    };
  }
  return {
    ...capability,
    checkedAt: receivedAt,
    expiresAt: new Date(receivedTime + duration).toISOString()
  };
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
