import type {
  RoadmapDependency,
  RoadmapIssueNode,
  RoadmapIssueReference,
  RoadmapPlanItem,
  RoadmapResult
} from '../../src/shared/roadmap-api';
import {
  roadmapCyclicIssueKeys,
  roadmapGraphRevision,
  roadmapIssueKey
} from '../../src/shared/roadmap-model';
import { isValidGitHubRepositoryFullName } from '../../src/shared/github-repository-summary';
import { stripGitHubIssueCreationMarker } from '../../src/shared/github-issue-creation-marker';
import {
  getGitHubClientId,
  GitHubRequestError,
  requestGitHub,
  resolveOAuthToken,
  resolveToken
} from '../local-github-catalog';
import { getCurrentAuthSession } from '../local-auth-store';
import type { RoadmapPlanStore } from './roadmap-store';
import { getRoadmapPlanStore } from './roadmap-store-provider';

interface GitHubRepository {
  archived?: boolean;
  disabled?: boolean;
  full_name: string;
  id: number;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean };
}

export interface GitHubRoadmapIssue {
  body?: string | null;
  html_url: string;
  id: number;
  labels?: Array<{ name?: string } | string>;
  number: number;
  pull_request?: unknown;
  repository_url?: string;
  state: 'open' | 'closed';
  title: string;
  updated_at?: string;
}

export interface RoadmapServiceDependencies {
  dependencyPrincipal(): string;
  getGitHubClientId(): string;
  getStore(): Promise<RoadmapPlanStore>;
  now(): Date;
  requestGitHub<T>(path: string, token: string, init?: RequestInit): Promise<T>;
  resolveOAuthToken(): Promise<{ source?: 'environment' | 'stored-oauth'; token: string } | null>;
  resolveToken(): Promise<{ source?: 'environment' | 'stored-oauth'; token: string } | null>;
}

export interface RoadmapContext {
  auth: { source?: 'environment' | 'stored-oauth'; token: string };
  dependencyPrincipal: string;
  repository: GitHubRepository;
  repositoryPath: string;
  store: RoadmapPlanStore;
}

export const defaultRoadmapServiceDependencies: RoadmapServiceDependencies = {
  dependencyPrincipal: () => getCurrentAuthSession()?.userId ?? 'local',
  getGitHubClientId,
  getStore: getRoadmapPlanStore,
  now: () => new Date(),
  requestGitHub,
  resolveOAuthToken,
  resolveToken
};

const pageSize = 100;
const maximumIssuePages = 100;
const dependencyLoadConcurrency = 6;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index] as T, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  );
  return results;
}

export function roadmapRepositoryPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function issueRepositoryFullName(issue: GitHubRoadmapIssue, fallback: string) {
  const match = issue.repository_url?.match(/\/repos\/([^/]+\/[^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

export function roadmapIssueReference(
  fullName: string,
  issue: GitHubRoadmapIssue
): RoadmapIssueReference {
  return { fullName, id: issue.id, number: issue.number, url: issue.html_url };
}

function issueLabels(issue: GitHubRoadmapIssue) {
  return (issue.labels ?? []).flatMap((label) => {
    const value = typeof label === 'string' ? label : label.name;
    return value ? [value] : [];
  });
}

function canEditRepository(repository: GitHubRepository) {
  return repository.archived !== true
    && repository.disabled !== true
    && Boolean(
      repository.permissions?.admin
      || repository.permissions?.maintain
      || repository.permissions?.push
      || repository.permissions?.triage
    );
}

export function roadmapStatusForError(error: unknown): RoadmapResult['status'] {
  if (error instanceof GitHubRequestError) {
    if (error.rateLimited) return 'rate-limited';
    if (error.statusCode === 401 || error.statusCode === 403) return 'unauthorized';
  }
  return 'error';
}

export function emptyRoadmapResult(
  fullName: string,
  checkedAt: string,
  status: RoadmapResult['status'],
  message: string
): RoadmapResult {
  return {
    availableIssues: [],
    canEdit: false,
    checkedAt,
    dependencies: [],
    dependencySync: 'current',
    graphRevision: roadmapGraphRevision([]),
    issues: [],
    message,
    plan: { goals: [], items: [], revision: 0 },
    repository: { fullName, id: 0 },
    status
  };
}

export async function listRoadmapIssues(
  context: RoadmapContext,
  dependencies: RoadmapServiceDependencies
) {
  const issues: GitHubRoadmapIssue[] = [];
  for (let page = 1; page <= maximumIssuePages; page += 1) {
    const batch = await dependencies.requestGitHub<GitHubRoadmapIssue[]>(
      `/repos/${context.repositoryPath}/issues?state=all&per_page=${pageSize}&page=${page}`,
      context.auth.token
    );
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < pageSize) return issues;
  }
  throw new Error('This repository has too many issues to load safely.');
}

export async function loadRoadmapContext(
  fullName: string,
  dependencies: RoadmapServiceDependencies,
  write = false
): Promise<RoadmapContext> {
  if (!isValidGitHubRepositoryFullName(fullName)) {
    throw new Error('Repository name must include a valid owner and name.');
  }
  const auth = write ? await dependencies.resolveOAuthToken() : await dependencies.resolveToken();
  if (!auth) throw new Error('GITHUB_AUTH_REQUIRED');
  const path = roadmapRepositoryPath(fullName);
  const [repository, store] = await Promise.all([
    dependencies.requestGitHub<GitHubRepository>(`/repos/${path}`, auth.token),
    dependencies.getStore()
  ]);
  return {
    auth,
    dependencyPrincipal: dependencies.dependencyPrincipal(),
    repository,
    repositoryPath: path,
    store
  };
}

function cachedDependenciesFor(
  dependencies: readonly RoadmapDependency[],
  blocked: RoadmapIssueReference
) {
  const key = roadmapIssueKey(blocked);
  return dependencies
    .filter((dependency) => roadmapIssueKey(dependency.blocked) === key)
    .map((dependency) => ({ ...dependency, freshness: 'stale' as const }));
}

export async function listRoadmapBlockers(
  context: RoadmapContext,
  blocked: RoadmapIssueReference,
  dependencies: RoadmapServiceDependencies
) {
  const blockers: RoadmapIssueReference[] = [];
  const repositoryPath = roadmapRepositoryPath(blocked.fullName);
  for (let page = 1; page <= maximumIssuePages; page += 1) {
    const batch = await dependencies.requestGitHub<GitHubRoadmapIssue[]>(
      `/repos/${repositoryPath}/issues/${blocked.number}/dependencies/blocked_by?per_page=100&page=${page}`,
      context.auth.token
    );
    blockers.push(...batch.map((blocker) => roadmapIssueReference(
      issueRepositoryFullName(blocker, blocked.fullName),
      blocker
    )));
    if (batch.length < pageSize) return blockers;
  }
  throw new Error('This issue has too many dependencies to load safely.');
}

export async function loadRoadmapDependencies(
  context: RoadmapContext,
  items: readonly RoadmapPlanItem[],
  cached: readonly RoadmapDependency[],
  dependencies: RoadmapServiceDependencies
) {
  const staleBlockedKeys = new Set<string>();
  const results = await mapWithConcurrency(
    items,
    dependencyLoadConcurrency,
    async (item) => {
    try {
      const blockers = await listRoadmapBlockers(context, item.issue, dependencies);
      return blockers.map((blocker) => ({
        blocked: item.issue,
        blocker,
        freshness: 'current' as const
      }));
    } catch {
      staleBlockedKeys.add(roadmapIssueKey(item.issue));
      return cachedDependenciesFor(cached, item.issue);
    }
    }
  );
  const loaded = results.flat();
  const unique = new Map(loaded.map((edge) => [
    `${roadmapIssueKey(edge.blocker)}>${roadmapIssueKey(edge.blocked)}`,
    edge
  ]));
  return {
    allCurrent: staleBlockedKeys.size === 0,
    dependencies: [...unique.values()],
    staleBlockedKeys
  };
}

async function fetchIssue(
  context: RoadmapContext,
  reference: RoadmapIssueReference,
  dependencies: RoadmapServiceDependencies
) {
  const path = roadmapRepositoryPath(reference.fullName);
  return dependencies.requestGitHub<GitHubRoadmapIssue>(
    `/repos/${path}/issues/${reference.number}`,
    context.auth.token
  );
}

function availabilityFor(
  issue: GitHubRoadmapIssue,
  reference: RoadmapIssueReference,
  graph: readonly RoadmapDependency[],
  issueStates: ReadonlyMap<string, GitHubRoadmapIssue['state']>,
  staleBlockedKeys: ReadonlySet<string>,
  cyclicKeys: ReadonlySet<string>
): RoadmapIssueNode['availability'] {
  if (issue.state === 'closed') return 'closed';
  const key = roadmapIssueKey(reference);
  if (cyclicKeys.has(key)) return 'cyclic';
  if (staleBlockedKeys.has(key)) return 'stale';
  const related = graph.filter((dependency) => (
    roadmapIssueKey(dependency.blocked) === key || roadmapIssueKey(dependency.blocker) === key
  ));
  if (related.some((dependency) => dependency.freshness === 'stale')) return 'stale';
  const blocked = graph.some((dependency) => (
    roadmapIssueKey(dependency.blocked) === key
    && issueStates.get(roadmapIssueKey(dependency.blocker)) !== 'closed'
  ));
  return blocked ? 'blocked' : 'ready';
}

export async function buildRoadmapResult(
  context: RoadmapContext,
  dependencies: RoadmapServiceDependencies,
  options: {
    loadedGraph?: Awaited<ReturnType<typeof loadRoadmapDependencies>>;
    plan?: RoadmapResult['plan'];
    repositoryIssues?: GitHubRoadmapIssue[];
  } = {}
): Promise<RoadmapResult> {
  const stored = await context.store.read(context.repository.id, context.dependencyPrincipal);
  const repositoryIssues = options.repositoryIssues ?? await listRoadmapIssues(context, dependencies);
  const issuesById = new Map(repositoryIssues.map((issue) => [issue.id, issue]));
  const storedPlan = {
    goals: stored?.goals ?? [],
    items: (stored?.items ?? []).map((item) => {
      const issue = issuesById.get(item.issue.id);
      return issue
        ? { ...item, issue: roadmapIssueReference(context.repository.full_name, issue) }
        : item;
    }),
    revision: stored?.revision ?? 0,
    updatedAt: stored?.updatedAt
  };
  const plan = options.plan ?? storedPlan;
  const issuesByNumber = new Map(repositoryIssues.map((issue) => [issue.number, issue]));
  const loadedGraph = options.loadedGraph ?? await loadRoadmapDependencies(
    context,
    plan.items,
    stored?.dependencies ?? [],
    dependencies
  );
  const references = new Map<string, RoadmapIssueReference>();
  plan.items.forEach((item) => references.set(roadmapIssueKey(item.issue), item.issue));
  loadedGraph.dependencies.forEach((edge) => {
    references.set(roadmapIssueKey(edge.blocked), edge.blocked);
    references.set(roadmapIssueKey(edge.blocker), edge.blocker);
  });
  const fetchedIssues = new Map<string, GitHubRoadmapIssue>();
  const unavailable = new Map<string, RoadmapIssueNode['availability']>();
  for (const reference of references.values()) {
    const key = roadmapIssueKey(reference);
    const local = reference.fullName.toLowerCase() === context.repository.full_name.toLowerCase()
      ? issuesByNumber.get(reference.number)
      : undefined;
    if (local) {
      fetchedIssues.set(key, local);
      continue;
    }
    try {
      fetchedIssues.set(key, await fetchIssue(context, reference, dependencies));
    } catch (error) {
      unavailable.set(key, error instanceof GitHubRequestError && error.statusCode === 410
        ? 'missing'
        : reference.fullName.toLowerCase() === context.repository.full_name.toLowerCase()
          ? 'missing'
          : 'inaccessible');
    }
  }
  const issueStates = new Map(
    [...fetchedIssues].map(([key, issue]) => [key, issue.state] as const)
  );
  const cyclicKeys = roadmapCyclicIssueKeys(loadedGraph.dependencies);
  const issues = [...references.values()].map<RoadmapIssueNode>((reference) => {
    const key = roadmapIssueKey(reference);
    const issue = fetchedIssues.get(key);
    if (!issue) {
      const availability = unavailable.get(key) ?? 'inaccessible';
      return {
        availability,
        description: '',
        issue: reference,
        labels: [],
        state: 'unknown',
        title: availability === 'missing' ? 'Issue no longer exists' : 'Issue is not accessible'
      };
    }
    return {
      availability: availabilityFor(
        issue,
        reference,
        loadedGraph.dependencies,
        issueStates,
        loadedGraph.staleBlockedKeys,
        cyclicKeys
      ),
      description: stripGitHubIssueCreationMarker(issue.body ?? ''),
      issue: roadmapIssueReference(reference.fullName, issue),
      labels: issueLabels(issue),
      state: issue.state,
      title: issue.title,
      updatedAt: issue.updated_at
    };
  });
  const checkedAt = dependencies.now().toISOString();
  if (loadedGraph.allCurrent) {
    await context.store.saveDependencies(
      context.repository.id,
      context.repository.full_name,
      context.dependencyPrincipal,
      loadedGraph.dependencies,
      checkedAt
    );
  }
  return {
    availableIssues: repositoryIssues.map((issue) => ({
      description: stripGitHubIssueCreationMarker(issue.body ?? ''),
      issue: roadmapIssueReference(context.repository.full_name, issue),
      state: issue.state,
      title: issue.title
    })),
    canEdit: context.auth.source !== 'environment' && canEditRepository(context.repository),
    checkedAt,
    dependencies: loadedGraph.dependencies,
    dependencySync: loadedGraph.allCurrent ? 'current' : 'stale',
    graphRevision: roadmapGraphRevision(loadedGraph.dependencies),
    issues,
    plan,
    repository: { fullName: context.repository.full_name, id: context.repository.id },
    status: 'connected'
  };
}
