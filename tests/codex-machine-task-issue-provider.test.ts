import { describe, expect, test } from 'bun:test';

import {
  CodexMachineTaskIssueError,
  createCodexMachineTaskIssueProvider
} from '../server/codex-machine-tasks/issue-provider';

const commit = 'a'.repeat(40);
const repository = {
  defaultBranch: 'main',
  fullName: 'DotNaos/project-space',
  id: 42,
  isPrivate: true,
  name: 'project-space',
  owner: 'DotNaos',
  projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
  url: 'https://github.com/DotNaos/project-space'
};
const issue = {
  labels: [],
  number: 262,
  state: 'open' as const,
  title: 'Build Codex machine task core and CLI',
  url: 'https://github.com/DotNaos/project-space/issues/262'
};

describe('Codex machine-task issue provider', () => {
  test('creates one deterministic issue branch from the exact default branch and commit', async () => {
    const calls: unknown[] = [];
    const provider = createCodexMachineTaskIssueProvider({
      async createGitHubBranch(request) {
        calls.push(request);
        return {
          branch: { commitSha: commit, isDefault: false, name: request.name },
          status: 'connected' as const
        };
      },
      async getGitHubCatalog() {
        return { checkedAt: '', repositories: [repository], status: 'connected' as const };
      },
      async getGitHubRepositoryDetails(fullName) {
        expect(fullName).toBe(repository.fullName);
        return {
          branches: [{ commitSha: commit, isDefault: true, name: 'main' }],
          checkedAt: '', issues: [issue], pullRequests: [], status: 'connected' as const
        };
      }
    });

    await expect(provider({
      issue: 262,
      repositoryId: 'DotNaos/project-space',
      userId: 'user-owner'
    })).resolves.toEqual({
      branch: 'issue-262-build-codex-machine-task-core-and-cli',
      commit,
      issue: { number: 262, url: issue.url },
      repository: { id: '42', nameWithOwner: repository.fullName }
    });
    expect(calls).toEqual([{
      fullName: repository.fullName,
      issueNumber: 262,
      name: 'issue-262-build-codex-machine-task-core-and-cli',
      sourceBranch: 'main'
    }]);
  });

  test('fails structurally before branch creation for authorization and repository failures', async () => {
    for (const scenario of ['github', 'repository', 'issue', 'branch'] as const) {
      let writes = 0;
      const provider = createCodexMachineTaskIssueProvider({
        async createGitHubBranch() {
          writes += 1;
          return { status: scenario === 'branch' ? 'error' as const : 'connected' as const };
        },
        async getGitHubCatalog() {
          return {
            checkedAt: '',
            repositories: scenario === 'repository' ? [] : [repository],
            status: scenario === 'github' ? 'auth-required' as const : 'connected' as const
          };
        },
        async getGitHubRepositoryDetails() {
          return {
            branches: [], checkedAt: '',
            issues: scenario === 'issue' ? [] : [issue],
            pullRequests: [], status: 'connected' as const
          };
        }
      });
      const rejected = provider({ issue: 262, repositoryId: '42', userId: 'user-owner' });
      await expect(rejected).rejects.toBeInstanceOf(CodexMachineTaskIssueError);
      expect(writes).toBe(scenario === 'branch' ? 1 : 0);
    }
  });
});
