import type {
  ConnectorOverviewResult,
  GitHubCatalogRepository,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import type { GitHubRepositorySummaryResult } from '@/shared/github-repository-summary';
import type {
  ProjectChatChannelListResult,
  ProjectChatMemberListResult
} from '@/shared/project-chat-api';
import { projectChatProjectId } from '../../../shared/project-chat-project';
import { routeForView } from '../hooks/project-desktop-routing';

export type ProjectRootEvidence<T> =
  | { state: 'loading' }
  | { message: string; state: 'blocked' }
  | { checkedAt: string; state: 'ready'; value: T };

export type ProjectRootCount =
  | { state: 'loading' }
  | { message: string; state: 'blocked' }
  | { checkedAt: string; count: number; state: 'ready' };

export interface ProjectRootSummaryTarget {
  key: string;
  label: string;
  machineIds: string[];
  project: ProjectSpaceRecord;
  repository?: GitHubCatalogRepository;
  sourceProjectIds: string[];
}

export interface ProjectRootSummaryCounts {
  branches: ProjectRootCount;
  issues: ProjectRootCount;
  machines: ProjectRootCount;
  threads: ProjectRootCount;
}

export interface ProjectRootSummaryDataSource {
  getRepositorySummary(fullName: string): Promise<GitHubRepositorySummaryResult>;
  listProjectChatChannels(projectId: string): Promise<ProjectChatChannelListResult>;
  listProjectChatMembers(channelId: string): Promise<ProjectChatMemberListResult>;
}

export interface ProjectRootSummaryLoadResult {
  branches: ProjectRootCount;
  issues: ProjectRootCount;
  scopeKey: string;
  threads: ProjectRootCount;
}

export interface ProjectRootSummaryRequestState {
  generation: number;
  result?: ProjectRootSummaryLoadResult;
  scopeKey: string;
}

export interface ProjectRootSummaryResponse {
  generation: number;
  result: ProjectRootSummaryLoadResult;
  scopeKey: string;
}

export interface ProjectRootSummaryActions {
  chat: string;
  issues: string;
  machines: string;
  newIssue?: string;
  workspaces: string;
}

export function projectRootSummaryHref(path: string, search = '', hash = '') {
  return `${path}${search}${hash}`;
}

function normalize(value: string) {
  return value.normalize('NFKC').trim().replace(/^@/, '').toLocaleLowerCase();
}

function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function projectRepositoryCandidates(project: ProjectSpaceRecord) {
  return new Set(
    [project.name, basename(project.rootPath)]
      .map(normalize)
      .filter(Boolean)
  );
}

function repositoryCandidates(repository: GitHubCatalogRepository) {
  return new Set([repository.fullName, repository.name].map(normalize));
}

function setsOverlap(left: Set<string>, right: Set<string>) {
  return [...left].some((value) => right.has(value));
}

function inferredRepository(
  project: ProjectSpaceRecord,
  repositories: GitHubCatalogRepository[]
) {
  if (project.github) return project.github;
  const candidates = projectRepositoryCandidates(project);
  const matches = repositories.filter((repository) =>
    setsOverlap(candidates, repositoryCandidates(repository))
  );

  return matches.length === 1 ? matches[0] : undefined;
}

function repositoryKey(repository: GitHubCatalogRepository) {
  return `github:${repository.id}`;
}

function localProjectKey(project: ProjectSpaceRecord) {
  return `local:${normalize(project.machineId ?? 'local')}:${normalize(project.id)}`;
}

function projectLabel(project: ProjectSpaceRecord, repository?: GitHubCatalogRepository) {
  return repository?.name ?? project.name ?? basename(project.rootPath) ?? 'Untitled project';
}

function preferredProject(
  projects: ProjectSpaceRecord[],
  recentRank: Map<string, number>
) {
  return [...projects].sort((left, right) => {
    const kindDelta = Number(left.kind === 'github') - Number(right.kind === 'github');
    if (kindDelta !== 0) return kindDelta;

    const recentDelta =
      (recentRank.get(left.id) ?? Number.POSITIVE_INFINITY) -
      (recentRank.get(right.id) ?? Number.POSITIVE_INFINITY);
    if (recentDelta !== 0) return recentDelta;

    return left.id.localeCompare(right.id);
  })[0]!;
}

function targetMachineIds(projects: ProjectSpaceRecord[]) {
  return Array.from(
    new Set(
      projects
        .filter((project) => project.kind !== 'github')
        .map((project) => project.machineId ?? 'local')
    )
  ).sort();
}

export function selectProjectRootSummaryTargets(
  projects: ProjectSpaceRecord[],
  recentProjectIds: string[],
  limit = 3
): ProjectRootSummaryTarget[] {
  if (limit <= 0) return [];

  const repositories = Array.from(
    new Map(
      projects
        .flatMap((project) => (project.github ? [project.github] : []))
        .map((repository) => [repositoryKey(repository), repository])
    ).values()
  );
  const recentRank = new Map(recentProjectIds.map((id, index) => [id, index]));
  const groups = new Map<
    string,
    { projects: ProjectSpaceRecord[]; repository?: GitHubCatalogRepository }
  >();

  for (const project of projects) {
    const repository = inferredRepository(project, repositories);
    const key = repository ? repositoryKey(repository) : localProjectKey(project);
    const group = groups.get(key) ?? { projects: [], repository };
    group.projects.push(project);
    group.repository ??= repository;
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const project = preferredProject(group.projects, recentRank);
      const rank = Math.min(
        ...group.projects.map((entry) => recentRank.get(entry.id) ?? Number.POSITIVE_INFINITY)
      );

      return {
        rank,
        target: {
          key,
          label: projectLabel(project, group.repository),
          machineIds: targetMachineIds(group.projects),
          project,
          repository: group.repository,
          sourceProjectIds: group.projects.map((entry) => entry.id).sort()
        }
      };
    })
    .sort((left, right) => {
      const leftIsRecent = Number.isFinite(left.rank);
      const rightIsRecent = Number.isFinite(right.rank);
      if (leftIsRecent !== rightIsRecent) return leftIsRecent ? -1 : 1;
      if (leftIsRecent && rightIsRecent && left.rank !== right.rank) {
        return left.rank - right.rank;
      }
      const labelDelta = left.target.label.localeCompare(right.target.label);
      return labelDelta !== 0 ? labelDelta : left.target.key.localeCompare(right.target.key);
    })
    .slice(0, limit)
    .map(({ target }) => target);
}

export function projectRootSummaryScopeKey(target: ProjectRootSummaryTarget) {
  const repository = target.repository?.fullName ?? 'local';
  return `${target.key}:${target.project.id}:${normalize(repository)}`;
}

export function projectRootSummaryActions(
  target: ProjectRootSummaryTarget
): ProjectRootSummaryActions {
  const projectId = target.project.id;
  return {
    chat: routeForView('project', projectId, 'chat'),
    issues: routeForView('project', projectId, 'issues'),
    machines: routeForView('project', projectId, 'machines'),
    newIssue: target.repository
      ? routeForView('project', projectId, 'issues', 'new')
      : undefined,
    workspaces: routeForView('project', projectId, 'workspaces')
  };
}

function blocked(message: string): ProjectRootCount {
  return { message, state: 'blocked' };
}

function ready(count: number, checkedAt: string): ProjectRootCount {
  return { checkedAt, count, state: 'ready' };
}

export function projectRootMachineCount(
  target: ProjectRootSummaryTarget,
  connector: ProjectRootEvidence<ConnectorOverviewResult>
): ProjectRootCount {
  if (connector.state !== 'ready') return connector;

  const localMachineId = connector.value.machines.find(
    (machine) => machine.connector.status === 'local'
  )?.id;
  if (target.machineIds.length === 0) {
    return blocked('No project-scoped machine identity is available.');
  }
  if (target.machineIds.includes('local') && !localMachineId) {
    return blocked('The connector did not identify the current local machine.');
  }
  const scopedIds = new Set(
    target.machineIds.map((machineId) => (machineId === 'local' ? localMachineId : machineId))
  );
  const count = connector.value.machines.filter((machine) => scopedIds.has(machine.id)).length;

  return ready(count, connector.checkedAt);
}

async function loadRepositoryCounts(
  target: ProjectRootSummaryTarget,
  dataSource: ProjectRootSummaryDataSource
) {
  if (!target.repository) {
    const state = blocked('Connect a GitHub repository to load this count.');
    return { branches: state, issues: state };
  }

  try {
    const result = await dataSource.getRepositorySummary(target.repository.fullName);
    if (result.fullName !== target.repository.fullName) {
      const state = blocked('GitHub returned counts for a different repository.');
      return { branches: state, issues: state };
    }
    if (result.status !== 'connected') {
      const state = blocked(result.message || 'GitHub repository counts are unavailable.');
      return { branches: state, issues: state };
    }

    return {
      branches: ready(result.branchCount, result.checkedAt),
      issues: ready(result.openIssueCount, result.checkedAt)
    };
  } catch (error) {
    const state = blocked(
      error instanceof Error ? error.message : 'GitHub repository counts are unavailable.'
    );
    return { branches: state, issues: state };
  }
}

async function loadThreadCount(
  target: ProjectRootSummaryTarget,
  dataSource: ProjectRootSummaryDataSource
): Promise<ProjectRootCount> {
  try {
    const chatProjectId = projectChatProjectId(target.project, target.repository);
    const result = await dataSource.listProjectChatChannels(chatProjectId);
    const channels = Array.isArray(result?.channels) ? result.channels : [];
    const channel = channels[0];
    if (
      channels.length !== 1 ||
      !channel ||
      channel.kind !== 'project' ||
      channel.projectId !== chatProjectId ||
      typeof channel.channelId !== 'string' ||
      channel.channelId.trim().length === 0
    ) {
      return blocked('Project Chat returned invalid scoped channel evidence.');
    }

    const members = await dataSource.listProjectChatMembers(channel.channelId);
    const activeThreadIds = new Set(
      members.members
        .filter((member) => member.presence.state !== 'offline')
        .map((member) => member.origin?.threadId)
        .filter((threadId): threadId is string => Boolean(threadId))
    );
    const checkedAt = members.members.reduce(
      (latest, member) =>
        member.presence.lastSeenAt > latest ? member.presence.lastSeenAt : latest,
      new Date().toISOString()
    );

    return ready(activeThreadIds.size, checkedAt);
  } catch (error) {
    return blocked(error instanceof Error ? error.message : 'Project Chat presence is unavailable.');
  }
}

export async function loadProjectRootSummaryCounts(
  target: ProjectRootSummaryTarget,
  dataSource: ProjectRootSummaryDataSource
): Promise<ProjectRootSummaryLoadResult> {
  const scopeKey = projectRootSummaryScopeKey(target);
  const [repository, threads] = await Promise.all([
    loadRepositoryCounts(target, dataSource),
    loadThreadCount(target, dataSource)
  ]);

  return { ...repository, scopeKey, threads };
}

export function acceptProjectRootSummaryResponse(
  current: ProjectRootSummaryRequestState,
  response: ProjectRootSummaryResponse
): ProjectRootSummaryRequestState {
  if (
    response.scopeKey !== current.scopeKey ||
    response.generation !== current.generation ||
    response.result.scopeKey !== current.scopeKey
  ) {
    return current;
  }

  return { ...current, result: response.result };
}

export function projectRootSummaryCounts(
  target: ProjectRootSummaryTarget,
  connector: ProjectRootEvidence<ConnectorOverviewResult>,
  loaded?: ProjectRootSummaryLoadResult
): ProjectRootSummaryCounts {
  const scopeKey = projectRootSummaryScopeKey(target);
  const current = loaded?.scopeKey === scopeKey ? loaded : undefined;

  return {
    branches: current?.branches ?? { state: 'loading' },
    issues: current?.issues ?? { state: 'loading' },
    machines: projectRootMachineCount(target, connector),
    threads: current?.threads ?? { state: 'loading' }
  };
}
