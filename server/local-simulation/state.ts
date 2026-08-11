import type {
  GitHubBranchRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  GitHubWorkflowRunSummary,
  ProjectWorktreeRecord,
  ProjectsState
} from '../../src/shared/project-space-api';
import type { CodexMachineTaskIdentity } from '../../src/shared/codex-machine-tasks-api';

export const localSimulationSchema = 'project-space.local-simulation/v1' as const;

export interface LocalSimulationState {
  codexMessages?: Array<{ id: string; role: 'assistant' | 'user'; sequence?: number; text: string }>;
  codexTask?: CodexMachineTaskIdentity;
  credentials: {
    sessionSigningKey: string;
  };
  createdAt: string;
  devServer: {
    startedAt?: string;
    state: 'running' | 'stopped';
  };
  github: {
    branches: GitHubBranchRecord[];
    comments: Record<string, GitHubIssueCommentRecord[]>;
    issues: GitHubIssueRecord[];
    pullRequests: GitHubPullRequestRecord[];
    repository: {
      defaultBranch: string;
      description: string;
      fullName: string;
      id: number;
      name: string;
      owner: string;
    };
    workflowRuns: GitHubWorkflowRunSummary[];
  };
  issueCreationOperations?: Record<string, number>;
  machine: {
    id: string;
    name: string;
  };
  projectsState: ProjectsState;
  revision: number;
  scenario: 'active-development';
  schema: typeof localSimulationSchema;
  updatedAt: string;
  worktrees: ProjectWorktreeRecord[];
}

export function isLocalSimulationState(value: unknown): value is LocalSimulationState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<LocalSimulationState>;
  return (
    state.schema === localSimulationSchema &&
    state.scenario === 'active-development' &&
    Number.isSafeInteger(state.revision) &&
    Array.isArray(state.worktrees) &&
    Array.isArray(state.github?.issues) &&
    Array.isArray(state.github?.branches) &&
    Array.isArray(state.github?.pullRequests) &&
    Array.isArray(state.github?.workflowRuns) &&
    typeof state.credentials?.sessionSigningKey === 'string' &&
    state.credentials.sessionSigningKey.length >= 32
  );
}
