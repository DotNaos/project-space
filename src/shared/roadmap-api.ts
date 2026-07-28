import type { GitHubCatalogStatus } from './project-space-api';

export type RoadmapPlannedState = 'planned' | 'active';
export type RoadmapIssueAvailability =
  | 'ready'
  | 'blocked'
  | 'closed'
  | 'cyclic'
  | 'missing'
  | 'inaccessible'
  | 'stale';

export interface RoadmapGoal {
  description?: string;
  id: string;
  title: string;
}

export interface RoadmapIssueReference {
  fullName: string;
  id: number;
  number: number;
  url?: string;
}

export interface RoadmapPlanItem {
  goalId?: string;
  issue: RoadmapIssueReference;
  plannedState: RoadmapPlannedState;
}

export interface RoadmapPlan {
  goals: RoadmapGoal[];
  items: RoadmapPlanItem[];
  revision: number;
  updatedAt?: string;
}

export interface RoadmapIssueNode {
  availability: RoadmapIssueAvailability;
  description?: string;
  issue: RoadmapIssueReference;
  labels: string[];
  state: 'open' | 'closed' | 'unknown';
  title: string;
  updatedAt?: string;
}

export interface RoadmapIssueSummary {
  description: string;
  issue: RoadmapIssueReference;
  state: 'open' | 'closed';
  title: string;
}

export interface RoadmapDependency {
  blocked: RoadmapIssueReference;
  blocker: RoadmapIssueReference;
  freshness: 'current' | 'stale';
}

export interface RoadmapResult {
  availableIssues?: RoadmapIssueSummary[];
  canEdit: boolean;
  checkedAt: string;
  conflict?: 'dependencies' | 'plan';
  dependencies: RoadmapDependency[];
  dependencySync: 'current' | 'stale';
  graphRevision: string;
  issues: RoadmapIssueNode[];
  message?: string;
  plan: RoadmapPlan;
  repository: {
    fullName: string;
    id: number;
  };
  status: GitHubCatalogStatus;
}

export interface RoadmapPlanItemInput {
  goalId?: string;
  issueNumber: number;
  plannedState: RoadmapPlannedState;
}

export interface RoadmapPlanUpdateRequest {
  expectedGraphRevision: string;
  expectedRevision: number;
  fullName: string;
  goals: RoadmapGoal[];
  items: RoadmapPlanItemInput[];
}

export interface RoadmapDependencyMutationRequest {
  blockedIssueNumber: number;
  blocker: {
    fullName: string;
    issueNumber: number;
  };
  expectedGraphRevision: string;
  fullName: string;
}

export type RoadmapGraphNodeState = 'DONE' | 'READY' | 'ACTIVE' | 'WAIT';

export interface RoadmapGraphNodeReference {
  number: number;
  repository: string;
}

export interface RoadmapGraphNode extends RoadmapGraphNodeReference {
  description: string;
  state: RoadmapGraphNodeState;
  title: string;
  url?: string;
}

export interface RoadmapGraphIssue extends RoadmapGraphNodeReference {
  description: string;
  title: string;
  url?: string;
}

export interface RoadmapGraphEdge {
  from: RoadmapGraphNodeReference;
  satisfied: boolean;
  to: RoadmapGraphNodeReference;
}

export interface RoadmapGraph {
  dependencyFreshness: RoadmapResult['dependencySync'];
  edges: RoadmapGraphEdge[];
  graphRevision: string;
  issues: RoadmapGraphIssue[];
  nodes: RoadmapGraphNode[];
  paths: RoadmapGraphNodeReference[][];
  repository: string;
}
