import type {
  ConnectorOverviewResult,
  DeployedEnvironmentStatusResult,
  GitHubRepositoryDetailsResult,
  ProjectDiscoveryResult,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type {
  CodexSessionListResult,
  CodexSessionReadResult,
  CodexSessionRecord
} from '@/shared/codex-sessions-api';
import {
  comparablePath,
  mapInventory,
  topologyProjectScope
} from './project-topology-inventory-evidence';
import { buildProjectTopology } from './project-topology-model';
import {
  topologyTaskId,
  type ProjectTopologyInventory,
  type TopologyInventoryResult,
  type TopologyTask,
  type TopologyTaskEvidence,
  type TopologyTaskLocationEvidence,
  type TopologyTaskWriteCapability,
  type TopologyWorktreeInventory
} from './project-topology-types';
import {
  withTopologySourceLimit,
  type TopologySourceScheduler
} from './project-topology-source-limiter';
import { revalidateTopologyPublication } from './project-topology-publication';

export type ProjectTopologySourceResult<T> = Exclude<
  TopologyInventoryResult<T>,
  { state: 'checking' }
>;

export type ProjectTopologyWorktreeSourceResult = Exclude<
  TopologyWorktreeInventory,
  { state: 'checking' }
>;

export interface ProjectTopologySource {
  discoverProjectWorktrees(
    projectId: string,
    machineId?: string,
    signal?: AbortSignal
  ): Promise<ProjectTopologyWorktreeSourceResult>;
  getConnectorOverview(
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<ConnectorOverviewResult>>;
  getDeployedEnvironmentStatus(
    repositoryFullName: string,
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<DeployedEnvironmentStatusResult>>;
  getGitHubRepositoryDetails(
    repositoryFullName: string,
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<GitHubRepositoryDetailsResult>>;
  listCodexSessions(
    machineId: string,
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<CodexSessionListResult>>;
  loadProjectDiscovery(
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<ProjectDiscoveryResult>>;
  readCodexSession(
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<CodexSessionReadResult>>;
  resolveCodexSessionLocation(
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<ProjectTopologySourceResult<TopologyTaskLocationEvidence>>;
  getCodexSessionWriteCapability?(
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<TopologyTaskWriteCapability>;
  getCodexSessionTaskEvidence?(
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<TopologyTaskEvidence>;
}

export interface ProjectTopologyLoadOptions {
  clock?: () => string;
  includeTranscripts?: boolean;
  signal?: AbortSignal;
}

type LocationAttempt =
  | { id: string; location: TopologyTaskLocationEvidence }
  | { failure: { checkedAt: string; reason: string }; id: string };

const sourceConcurrency = 6;
const maxReadyEvidenceAgeMs = 30_000;

export async function loadProjectTopologyInventory(
  source: ProjectTopologySource,
  options: ProjectTopologyLoadOptions = {}
): Promise<ProjectTopologyInventory> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const [projectAttempt, machineAttempt] = await Promise.all([
    capture(() => source.loadProjectDiscovery(options.signal)),
    capture(() => source.getConnectorOverview(options.signal))
  ]);
  const checkedAt = clock();
  const projectSource = projectAttempt.ok
    ? validateProjectTopologySourceResult(projectAttempt.value, checkedAt)
    : blocked(projectAttempt.error, checkedAt);
  const machineSource = machineAttempt.ok
    ? validateProjectTopologySourceResult(machineAttempt.value, checkedAt)
    : blocked(machineAttempt.error, checkedAt);
  const projects: ProjectTopologyInventory['projects'] = mapInventory(
    projectSource,
    (data) => data.projects
  );
  const machines: ProjectTopologyInventory['machines'] = mapInventory(
    machineSource,
    (data) => data.machines
  );
  const empty = emptyInventory(checkedAt, projects, machines);
  if (!hasInventoryData(projects) || !hasInventoryData(machines)) return empty;

  const repositoryNames = [...new Set(projects.data.flatMap((project) => (
    project.github?.fullName ? [project.github.fullName] : []
  )))];
  const machineIds = [...new Set(machines.data.map((machine) => machine.id))];
  const missingMachineIds = [...new Set(projects.data.map((project) => (
    project.machineId ?? 'unknown'
  )).filter((machineId) => !machineIds.includes(machineId)))];
  const [worktreesByProjectScope, repositoriesByFullName, deploymentsByRepository, codex] = (
    await withTopologySourceLimit(sourceConcurrency, options.signal, (scheduler) => Promise.all([
      loadEntries<ProjectSpaceRecord, TopologyWorktreeInventory>(projects.data, scheduler, async (project) => [
        topologyProjectScope(project),
        completedWorktreeSource(
          await source.discoverProjectWorktrees(project.id, project.machineId, options.signal),
          clock()
        )
      ] as const, (project, error) => [
        topologyProjectScope(project),
        {
          checkedAt: clock(),
          message: errorMessage(error),
          reason: 'request-failed' as const,
          state: 'blocked' as const
        }
      ] as const),
      loadInventoryEntries(repositoryNames, clock, scheduler, (fullName) => (
        loadConnectedRepository(source, fullName, options.signal)
      )),
      loadInventoryEntries(repositoryNames, clock, scheduler, (fullName) => (
        source.getDeployedEnvironmentStatus(fullName, options.signal)
      )),
      loadInventoryEntries(machineIds, clock, scheduler, (machineId) => (
        source.listCodexSessions(machineId, options.signal)
      ))
    ]))
  );
  const codexByMachineId: ProjectTopologyInventory['codexByMachineId'] = {
    ...codex,
    ...Object.fromEntries(missingMachineIds.map((machineId) => [machineId, {
      checkedAt: clock(),
      reason: 'The project registry references a machine that inventory did not return.',
      state: 'blocked' as const
    }]))
  };
  const sessions = [...new Map(Object.entries(codexByMachineId).flatMap(([
    machineId,
    result
  ]) => (
    (result.state === 'ready' || result.state === 'stale')
    && result.data.machine.id === machineId
    && result.data.sessions.every((session) => session.machineId === machineId)
      ? result.data.sessions.map((session) => [
          topologyTaskId(machineId, session.id),
          session
        ] as const)
      : []
  ))).values()];
  const locationAttempts: LocationAttempt[] = await withTopologySourceLimit(
    sourceConcurrency,
    options.signal,
    (scheduler) => Promise.all(sessions.map((session): Promise<LocationAttempt> => {
      const id = topologyTaskId(session.machineId, session.id);
      return scheduler.run(async () => {
        const result = await source.resolveCodexSessionLocation(
          session.machineId,
          session.id,
          options.signal
        );
        const observedAt = clock();
        const validated = validateProjectTopologySourceResult(result, observedAt);
        if (validated.state !== 'ready') {
          throw new Error(validated.state === 'blocked'
            ? validated.reason
            : 'Canonical location evidence is stale.');
        }
        const location = validated.data;
        if (!validLocationEvidence(location, session, observedAt)) {
          throw new Error('Canonical location evidence did not match the requested Codex task.');
        }
        return { id, location };
      }).catch((error) => ({
        failure: { checkedAt: clock(), reason: errorMessage(error) }, id
      }));
    }))
  );
  const taskLocationsByTaskId = Object.fromEntries(locationAttempts.flatMap((attempt) => (
    'location' in attempt ? [[attempt.id, attempt.location]] : []
  )));
  const taskLocationFailuresByTaskId = Object.fromEntries(locationAttempts.flatMap((attempt) => (
    'failure' in attempt ? [[attempt.id, attempt.failure]] : []
  )));
  const inventory: ProjectTopologyInventory = revalidateTopologyPublication({
    ...empty,
    checkedAt: clock(),
    codexByMachineId,
    deploymentsByRepository,
    repositoriesByFullName,
    taskLocationFailuresByTaskId,
    taskLocationsByTaskId,
    worktreesByProjectScope
  });
  if (options.includeTranscripts === false) return inventory;

  return loadProjectTopologyTaskDetails(source, inventory, options);
}

export async function loadProjectTopologyTaskDetails(
  source: ProjectTopologySource,
  inventory: ProjectTopologyInventory,
  options: Pick<ProjectTopologyLoadOptions, 'clock' | 'signal'> = {}
): Promise<ProjectTopologyInventory> {
  const clock = options.clock ?? (() => new Date().toISOString());
  const readOnlyInventory = withoutTopologyWriteCapabilities(inventory);

  const build = buildProjectTopology(readOnlyInventory);
  if (build.state !== 'ready') return readOnlyInventory;
  const tasks = [...new Map(build.snapshot.projects.flatMap((project) => (
    project.machines.flatMap((machine) => machine.tasks)
  )).map((task) => [task.id, task])).values()];
  const loadTaskEvidence = source.getCodexSessionTaskEvidence?.bind(source);
  const [conversationsByTaskId, taskEvidenceByTaskId] = (
    await withTopologySourceLimit(sourceConcurrency, options.signal, (scheduler) => {
      const conversations = loadEntries<
        TopologyTask,
        TopologyInventoryResult<CodexSessionReadResult>
      >(tasks, scheduler, async (task) => {
        const result = await source.readCodexSession(
          task.machineId,
          task.threadId,
          options.signal
        );
        return [task.id, validateProjectTopologySourceResult(result, clock())] as const;
      }, (task, error) => [task.id, blocked(error, clock())] as const);
      const taskEvidence = loadTaskEvidence
        ? loadOptionalTaskEvidence(tasks, scheduler, loadTaskEvidence, options.signal)
        : undefined;
      return Promise.all([
        conversations,
        taskEvidence ?? Promise.resolve(undefined)
      ]);
    })
  );
  return revalidateTopologyPublication({
    ...readOnlyInventory,
    checkedAt: clock(),
    conversationsByTaskId,
    ...(taskEvidenceByTaskId ? { taskEvidenceByTaskId } : {})
  });
}

export function withoutTopologyWriteCapabilities(
  inventory: ProjectTopologyInventory
): ProjectTopologyInventory {
  const { writeCapabilitiesByTaskId: _ignored, ...readOnlyInventory } = inventory;
  return readOnlyInventory;
}

async function loadOptionalTaskEvidence(
  tasks: TopologyTask[],
  scheduler: TopologySourceScheduler,
  load: (
    machineId: string,
    threadId: string,
    signal?: AbortSignal
  ) => Promise<TopologyTaskEvidence>,
  signal?: AbortSignal
) {
  const entries = await Promise.all(tasks.map((task) => scheduler.run(async () => (
    [task.id, await load(task.machineId, task.threadId, signal)] as const
  )).catch(() => undefined)));
  return Object.fromEntries(entries.filter((entry): entry is NonNullable<typeof entry> => (
    Boolean(entry)
  )));
}

function emptyInventory(
  checkedAt: string,
  projects: ProjectTopologyInventory['projects'],
  machines: ProjectTopologyInventory['machines']
): ProjectTopologyInventory {
  return {
    checkedAt,
    codexByMachineId: {},
    deploymentsByRepository: {},
    machines,
    projects,
    repositoriesByFullName: {},
    worktreesByProjectScope: {}
  };
}

async function loadInventoryEntries<T>(
  keys: string[],
  clock: () => string,
  scheduler: TopologySourceScheduler,
  load: (key: string) => Promise<ProjectTopologySourceResult<T>>
) {
  return loadEntries<string, TopologyInventoryResult<T>>(keys, scheduler, async (key) => {
    const result = await load(key);
    return [key, validateProjectTopologySourceResult(result, clock())] as const;
  }, (key, error) => [key, blocked(error, clock())] as const);
}

async function loadEntries<T, V>(
  values: T[],
  scheduler: TopologySourceScheduler,
  load: (value: T) => Promise<readonly [string, V]>,
  recover: (value: T, error: unknown) => readonly [string, V]
) {
  const entries = values.map((value) => scheduler.run(() => load(value)).catch((error) => (
    recover(value, error)
  )));
  return Object.fromEntries(await Promise.all(entries));
}

function blocked(error: unknown, checkedAt: string) {
  return { checkedAt, reason: errorMessage(error), state: 'blocked' as const };
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Topology inventory request failed.';
}

function hasInventoryData<T>(
  result: TopologyInventoryResult<T>
): result is Extract<TopologyInventoryResult<T>, { state: 'ready' | 'stale' }> {
  return result.state === 'ready' || result.state === 'stale';
}

export function validateProjectTopologySourceResult<T>(
  result: ProjectTopologySourceResult<T>,
  observedAt: string
): TopologyInventoryResult<T> {
  if (result.state === 'blocked') return result;
  const evidenceAt = result.state === 'ready' ? result.checkedAt : result.lastSafeAt;
  const evidenceTime = Date.parse(evidenceAt);
  const observedTime = Date.parse(observedAt);
  const nestedCheckedAt = checkedAtFromData(result.data);
  const nestedValue = nestedCheckedAt.present ? nestedCheckedAt.value : undefined;
  const nestedTime = nestedValue === undefined
    ? undefined
    : Date.parse(nestedValue);
  const nestedTimeValid = !nestedCheckedAt.present
    || (Number.isFinite(nestedTime) && nestedTime === evidenceTime);
  const readyTimeValid = result.state !== 'ready'
    || observedTime - evidenceTime <= maxReadyEvidenceAgeMs;
  return Number.isFinite(evidenceTime)
    && Number.isFinite(observedTime)
    && evidenceTime <= observedTime
    && readyTimeValid
    && nestedTimeValid
    ? result
    : {
        checkedAt: observedAt,
        reason: 'Source evidence timestamp was malformed, future-dated, or internally inconsistent.',
        state: 'blocked'
      };
}

function checkedAtFromData(data: unknown) {
  if (!data || typeof data !== 'object' || !('checkedAt' in data)) {
    return { present: false as const };
  }
  const checkedAt = (data as { checkedAt?: unknown }).checkedAt;
  return {
    present: true as const,
    ...(typeof checkedAt === 'string' ? { value: checkedAt } : {})
  };
}

function completedWorktreeSource(
  result: TopologyWorktreeInventory,
  checkedAt: string
): TopologyWorktreeInventory {
  if (result.state === 'blocked') return result;
  const observedTime = Date.parse(checkedAt);
  const evidenceAt = result.state === 'stale'
    ? result.data.evidence.checkedAt
    : result.state === 'checking'
      ? undefined
      : result.evidence.checkedAt;
  const evidenceTime = evidenceAt ? Date.parse(evidenceAt) : Number.NaN;
  const lastSafeTime = result.state === 'stale' ? Date.parse(result.lastSafeAt) : undefined;
  const valid = result.state !== 'checking'
    && Number.isFinite(observedTime)
    && Number.isFinite(evidenceTime)
    && evidenceTime <= observedTime
    && (result.state === 'stale'
      ? Number.isFinite(lastSafeTime) && evidenceTime === lastSafeTime
      : observedTime - evidenceTime <= maxReadyEvidenceAgeMs);
  return valid ? result : {
        checkedAt,
        message: result.state === 'checking'
          ? 'Worktree source completed without a final evidence state.'
          : 'Worktree source evidence was malformed, stale, or internally inconsistent.',
        reason: 'source-disagreement',
        state: 'blocked'
      };
}

function validLocationEvidence(
  evidence: TopologyTaskLocationEvidence,
  session: CodexSessionRecord,
  observedAt: string
) {
  const sessionTime = Date.parse(session.lastActivityAt);
  const evidenceTime = Date.parse(evidence.checkedAt);
  const observedTime = Date.parse(observedAt);
  return evidence.machineId === session.machineId
    && evidence.threadId === session.id
    && evidence.source === 'connector-realpath'
    && Boolean(comparablePath(evidence.canonicalCwd))
    && [sessionTime, evidenceTime, observedTime].every(Number.isFinite)
    && sessionTime <= evidenceTime
    && evidenceTime <= observedTime
    && observedTime - evidenceTime <= maxReadyEvidenceAgeMs;
}

async function capture<T>(load: () => Promise<T>) {
  try {
    return { ok: true as const, value: await load() };
  } catch (error) {
    return { error, ok: false as const };
  }
}

async function loadConnectedRepository(
  source: ProjectTopologySource,
  fullName: string,
  signal?: AbortSignal
) {
  const result = await source.getGitHubRepositoryDetails(fullName, signal);
  if (
    (result.state === 'ready' || result.state === 'stale')
    && result.data.status !== 'connected'
  ) {
    return {
      checkedAt: result.state === 'ready' ? result.checkedAt : result.lastSafeAt,
      reason: result.data.message ?? `GitHub repository inventory is ${result.data.status}.`,
      state: 'blocked' as const
    };
  }
  return result;
}
