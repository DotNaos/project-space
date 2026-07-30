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
    let detailReads = 0;
    const provider = createCodexMachineTaskIssueProvider({
      async createGitHubBranch(request) {
        calls.push(request);
        return {
          branch: { isDefault: false, name: request.name },
          status: 'connected' as const
        };
      },
      async getGitHubCatalog() {
        return { checkedAt: '', repositories: [repository], status: 'connected' as const };
      },
      async getGitHubRepositoryDetails(fullName) {
        expect(fullName).toBe(repository.fullName);
        detailReads += 1;
        return {
          branches: detailReads === 1
            ? [{ commitSha: commit, isDefault: true, name: 'main' }]
            : [
                { commitSha: commit, isDefault: true, name: 'main' },
                {
                  commitSha: commit,
                  isDefault: false,
                  name: 'issue-262-build-codex-machine-task-core-and-cli'
                }
              ],
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
    expect(detailReads).toBe(2);
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

  test('fails closed when the requested pull request head moved', async () => {
    const provider = createCodexMachineTaskIssueProvider({
      async createGitHubBranch() {
        throw new Error('Branch creation must not run.');
      },
      async getGitHubCatalog() {
        return { checkedAt: '', repositories: [repository], status: 'connected' as const };
      },
      async getGitHubRepositoryDetails() {
        return {
          branches: [{
            commitSha: commit,
            isDefault: false,
            name: 'issue-262-build-codex-machine-task-core-and-cli'
          }],
          checkedAt: '',
          issues: [issue],
          pullRequests: [],
          status: 'connected' as const
        };
      }
    });

    const rejected = provider({
      expectedBranch: 'issue-262-build-codex-machine-task-core-and-cli',
      expectedCommit: 'b'.repeat(40),
      issue: 262,
      repositoryId: repository.fullName,
      userId: 'user-owner'
    });
    await expect(rejected).rejects.toMatchObject({
      message: 'The issue branch no longer matches the requested pull request head.',
      reason: 'worktree_failure'
    });
  });

  test('accepts only the exact open pull request linked to the issue head', async () => {
    const branchName = 'feature/custom-prototype-branch';
    const provider = createCodexMachineTaskIssueProvider({
      async createGitHubBranch() {
        throw new Error('Branch creation must not run.');
      },
      async getGitHubCatalog() {
        return { checkedAt: '', repositories: [repository], status: 'connected' as const };
      },
      async getGitHubRepositoryDetails() {
        return {
          branches: [{ commitSha: commit, isDefault: false, name: branchName }],
          checkedAt: '',
          issues: [issue],
          pullRequests: [{
            headBranch: branchName,
            headSha: commit,
            linkedIssueNumbers: [issue.number],
            number: 381,
            state: 'open' as const,
            title: 'Prototype launch',
            url: 'https://github.com/DotNaos/project-space/pull/381'
          }],
          status: 'connected' as const
        };
      }
    });

    await expect(provider({
      expectedBranch: branchName,
      expectedCommit: commit,
      expectedPullRequestNumber: 381,
      issue: issue.number,
      repositoryId: repository.fullName,
      userId: 'user-owner'
    })).resolves.toMatchObject({ branch: branchName, commit });
  });
});
