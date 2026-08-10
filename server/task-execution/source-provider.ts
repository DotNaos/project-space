import type { GitHubTaskLocator } from '../../src/shared/task-execution-mcp-api';

export interface TaskExecutionSource {
  body?: string;
  branch: string;
  branchExists: boolean;
  commit?: string;
  provider: 'github';
  providerTaskId: string;
  repositoryId: string;
  repositoryName: string;
  taskId: string;
  title: string;
}

export interface TaskExecutionSourceProvider {
  prepare(actor: { userId: string }, task: GitHubTaskLocator): Promise<TaskExecutionSource>;
  resolve(actor: { userId: string }, task: GitHubTaskLocator): Promise<TaskExecutionSource>;
}

export class TaskExecutionSourceError extends Error {
  constructor(
    readonly reason: 'provider_authorization_required' | 'workspace_failure',
    message: string
  ) {
    super(message);
    this.name = 'TaskExecutionSourceError';
  }
}
