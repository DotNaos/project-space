import {
  MemoryGitHubIssueCreationOperationStore,
  PostgresGitHubIssueCreationOperationStore,
  type GitHubIssueCreationOperationStore
} from './github-issue-creation-operation-store';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured
} from './local-database-store';

const memoryStore = new MemoryGitHubIssueCreationOperationStore();
let postgresStore: Promise<GitHubIssueCreationOperationStore> | null = null;

export function getGitHubIssueCreationOperationStore() {
  if (!isDatabaseConfigured()) return Promise.resolve(memoryStore);
  postgresStore ??= getMachineConnectionDatabaseClient()
    .then((client) => new PostgresGitHubIssueCreationOperationStore(client))
    .catch((error) => {
      postgresStore = null;
      throw error;
    });
  return postgresStore;
}
