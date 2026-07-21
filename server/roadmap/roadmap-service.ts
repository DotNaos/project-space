import type {
  RoadmapDependencyMutationRequest,
  RoadmapGoal,
  RoadmapPlanItem,
  RoadmapPlanUpdateRequest,
  RoadmapResult
} from '../../src/shared/roadmap-api';
import {
  normalizedRoadmapGoals,
  roadmapDependencyCycle,
  roadmapIssueKey,
  roadmapOrderViolations
} from '../../src/shared/roadmap-model';
import { isValidGitHubRepositoryFullName } from '../../src/shared/github-repository-summary';
import { githubOAuthClientIdMissingMessage } from '../local-github-catalog';
import {
  buildRoadmapResult,
  defaultRoadmapServiceDependencies,
  emptyRoadmapResult,
  listRoadmapBlockers,
  listRoadmapIssues,
  loadRoadmapDependencies,
  loadRoadmapContext,
  roadmapIssueReference,
  roadmapRepositoryPath,
  roadmapStatusForError,
  type GitHubRoadmapIssue,
  type RoadmapServiceDependencies
} from './roadmap-loader';
import { RoadmapRevisionConflict } from './roadmap-store';

export type { RoadmapServiceDependencies } from './roadmap-loader';

function validateGoals(goals: readonly RoadmapGoal[]) {
  if (
    goals.length > 50
    || goals.some((goal) => (
      !goal
      || typeof goal.id !== 'string'
      || typeof goal.title !== 'string'
      || goal.description !== undefined && typeof goal.description !== 'string'
    ))
  ) {
    throw new Error('Every goal needs a unique ID and a title of 120 characters or less.');
  }
  const normalized = normalizedRoadmapGoals(goals);
  if (normalized.length !== goals.length) {
    throw new Error('Every goal needs a unique ID and a title of 120 characters or less.');
  }
  return normalized;
}

function assertCanEdit(result: RoadmapResult) {
  if (!result.canEdit) throw new Error('You do not have permission to edit this roadmap.');
}

function assertDependenciesEditable(result: RoadmapResult) {
  assertCanEdit(result);
  if (result.dependencySync === 'stale') {
    throw new Error('Refresh GitHub dependencies before editing the roadmap.');
  }
}

const maximumCycleTraversalIssues = 500;

async function hasLiveDependencyPathTo(
  context: Awaited<ReturnType<typeof loadRoadmapContext>>,
  start: RoadmapPlanItem['issue'],
  target: RoadmapPlanItem['issue'],
  dependencies: RoadmapServiceDependencies
) {
  const targetKey = roadmapIssueKey(target);
  const queue = [start];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const issue = queue.shift();
    if (!issue) break;
    const key = roadmapIssueKey(issue);
    if (key === targetKey) return true;
    if (visited.has(key)) continue;
    if (visited.size >= maximumCycleTraversalIssues) {
      throw new Error('The prerequisite chain is too large to validate safely.');
    }
    visited.add(key);
    queue.push(...await listRoadmapBlockers(context, issue, dependencies));
  }
  return false;
}

export class RoadmapService {
  constructor(
    private readonly dependencies: RoadmapServiceDependencies = defaultRoadmapServiceDependencies
  ) {}

  async get(fullName: string): Promise<RoadmapResult> {
    const checkedAt = this.dependencies.now().toISOString();
    try {
      return await buildRoadmapResult(
        await loadRoadmapContext(fullName, this.dependencies),
        this.dependencies
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'GITHUB_AUTH_REQUIRED') {
        const configured = Boolean(this.dependencies.getGitHubClientId());
        return emptyRoadmapResult(
          fullName,
          checkedAt,
          configured ? 'auth-required' : 'not-configured',
          configured ? 'Connect GitHub to load the roadmap.' : githubOAuthClientIdMissingMessage
        );
      }
      return emptyRoadmapResult(
        fullName,
        checkedAt,
        roadmapStatusForError(error),
        error instanceof Error ? error.message : 'Could not load the roadmap.'
      );
    }
  }

  async updatePlan(request: RoadmapPlanUpdateRequest): Promise<RoadmapResult> {
    const context = await loadRoadmapContext(request.fullName, this.dependencies, true);
    const repositoryIssues = await listRoadmapIssues(context, this.dependencies);
    const current = await buildRoadmapResult(
      context,
      this.dependencies,
      { repositoryIssues }
    );
    assertCanEdit(current);
    if (current.graphRevision !== request.expectedGraphRevision) {
      return {
        ...current,
        conflict: 'dependencies',
        message: 'Dependencies changed. Review the latest roadmap before saving.'
      };
    }
    const goals = validateGoals(request.goals);
    const goalIds = new Set(goals.map((goal) => goal.id));
    const issuesByNumber = new Map(repositoryIssues.map((issue) => [issue.number, issue]));
    const seen = new Set<number>();
    if (request.items.length > 500) throw new Error('A roadmap can contain at most 500 issues.');
    const items = request.items.map<RoadmapPlanItem>((item) => {
      const issue = issuesByNumber.get(item.issueNumber);
      if (!issue || seen.has(item.issueNumber)) {
        throw new Error(`Issue #${item.issueNumber} is missing or appears more than once.`);
      }
      if (item.goalId && !goalIds.has(item.goalId)) {
        throw new Error(`Issue #${item.issueNumber} refers to an unknown goal.`);
      }
      if (item.plannedState !== 'planned' && item.plannedState !== 'active') {
        throw new Error(`Issue #${item.issueNumber} has an invalid planned state.`);
      }
      seen.add(item.issueNumber);
      return {
        goalId: item.goalId,
        issue: roadmapIssueReference(context.repository.full_name, issue),
        plannedState: item.plannedState
      };
    });
    const currentIssueIds = new Set(current.plan.items.map((item) => roadmapIssueKey(item.issue)));
    const hasSameIssueSet = items.length === currentIssueIds.size
      && items.every((item) => currentIssueIds.has(roadmapIssueKey(item.issue)));
    const proposedGraph = hasSameIssueSet && current.dependencySync === 'current'
      ? {
          allCurrent: true,
          dependencies: current.dependencies,
          staleBlockedKeys: new Set<string>()
        }
      : await loadRoadmapDependencies(
          context,
          items,
          current.dependencies,
          this.dependencies
        );
    if (!proposedGraph.allCurrent) {
      throw new Error('Refresh GitHub dependencies before saving this planned order.');
    }
    if (roadmapOrderViolations(items, proposedGraph.dependencies).length > 0) {
      throw new Error('Planned order must keep every prerequisite before the work it blocks.');
    }
    try {
      const saved = await context.store.updatePlan({
        expectedRevision: request.expectedRevision,
        goals,
        items,
        repositoryFullName: context.repository.full_name,
        repositoryId: context.repository.id
      });
      return buildRoadmapResult(context, this.dependencies, {
        loadedGraph: proposedGraph,
        plan: {
          goals: saved.goals,
          items: saved.items,
          revision: saved.revision,
          updatedAt: saved.updatedAt
        },
        repositoryIssues
      });
    } catch (error) {
      if (error instanceof RoadmapRevisionConflict) {
        const latest = await buildRoadmapResult(context, this.dependencies);
        return {
          ...latest,
          conflict: 'plan',
          message: 'The plan changed elsewhere. Review the latest order before saving again.'
        };
      }
      throw error;
    }
  }

  async addDependency(request: RoadmapDependencyMutationRequest) {
    return this.mutateDependency(request, 'add');
  }

  async removeDependency(request: RoadmapDependencyMutationRequest) {
    return this.mutateDependency(request, 'remove');
  }

  private async mutateDependency(
    request: RoadmapDependencyMutationRequest,
    operation: 'add' | 'remove'
  ): Promise<RoadmapResult> {
    const context = await loadRoadmapContext(request.fullName, this.dependencies, true);
    const current = await buildRoadmapResult(context, this.dependencies);
    assertDependenciesEditable(current);
    if (current.graphRevision !== request.expectedGraphRevision) {
      return {
        ...current,
        conflict: 'dependencies',
        message: 'Dependencies changed. Review the latest roadmap before editing.'
      };
    }
    if (!isValidGitHubRepositoryFullName(request.blocker.fullName)) {
      throw new Error('The prerequisite repository must be an exact owner/name reference.');
    }
    const [blocked, blocker] = await Promise.all([
      this.dependencies.requestGitHub<GitHubRoadmapIssue>(
        `/repos/${context.repositoryPath}/issues/${request.blockedIssueNumber}`,
        context.auth.token
      ),
      this.dependencies.requestGitHub<GitHubRoadmapIssue>(
        `/repos/${roadmapRepositoryPath(request.blocker.fullName)}/issues/${request.blocker.issueNumber}`,
        context.auth.token
      )
    ]);
    const candidate = {
      blocked: roadmapIssueReference(context.repository.full_name, blocked),
      blocker: roadmapIssueReference(request.blocker.fullName, blocker)
    };
    const candidateKey = `${roadmapIssueKey(candidate.blocker)}>${roadmapIssueKey(candidate.blocked)}`;
    const exists = current.dependencies.some((dependency) => (
      `${roadmapIssueKey(dependency.blocker)}>${roadmapIssueKey(dependency.blocked)}` === candidateKey
    ));
    if (operation === 'add' && exists || operation === 'remove' && !exists) return current;
    if (operation === 'add' && roadmapDependencyCycle(current.dependencies, candidate)) {
      throw new Error('This dependency would create a cycle.');
    }
    if (operation === 'add' && await hasLiveDependencyPathTo(
      context,
      candidate.blocker,
      candidate.blocked,
      this.dependencies
    )) {
      throw new Error('This dependency would create a cycle.');
    }
    if (
      operation === 'add'
      && roadmapOrderViolations(current.plan.items, [
        ...current.dependencies,
        { ...candidate, freshness: 'current' }
      ]).length > 0
    ) {
      throw new Error(
        'Move the prerequisite before the issue it blocks in the manual plan order first.'
      );
    }
    const path = `/repos/${context.repositoryPath}/issues/${blocked.number}/dependencies/blocked_by`;
    if (operation === 'add') {
      await this.dependencies.requestGitHub(path, context.auth.token, {
        body: JSON.stringify({ issue_id: blocker.id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST'
      });
    } else {
      await this.dependencies.requestGitHub(`${path}/${blocker.id}`, context.auth.token, {
        method: 'DELETE'
      });
    }
    return buildRoadmapResult(context, this.dependencies);
  }
}

const roadmapService = new RoadmapService();

export const getRoadmap = (fullName: string) => roadmapService.get(fullName);
export const updateRoadmapPlan = (request: RoadmapPlanUpdateRequest) => roadmapService.updatePlan(request);
export const addRoadmapDependency = (request: RoadmapDependencyMutationRequest) => roadmapService.addDependency(request);
export const removeRoadmapDependency = (request: RoadmapDependencyMutationRequest) => roadmapService.removeDependency(request);
