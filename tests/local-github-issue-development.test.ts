import { describe, expect, test } from 'bun:test';
import {
  startGitHubIssueDevelopmentWithDependencies,
  type GitHubIssueDevelopmentDependencies
} from '../server/local-github-issue-development';
import type {
  GitHubBranchRecord,
  GitHubPullRequestRecord,
  GitHubRepositoryDetailsResult
} from '../src/shared/project-space-api';

const baseSha = 'a'.repeat(40);
const setupSha = 'c'.repeat(40);
const branchName = 'issue-494-starting-development';

const issue = {
  body: 'Start development should create the draft pull request.',
  labels: ['bug'],
  number: 494,
  state: 'open' as const,
  title: 'Starting development should create a draft PR',
  url: 'https://github.com/DotNaos/project-space/issues/494'
};

function branch(overrides: Partial<GitHubBranchRecord> = {}): GitHubBranchRecord {
  return {
    commitSha: baseSha,
    isDefault: false,
    linkedIssueNumbers: [494],
    name: branchName,
    ...overrides
  };
}

function pullRequest(overrides: Partial<GitHubPullRequestRecord> = {}): GitHubPullRequestRecord {
  return {
    baseBranch: 'main',
    headBranch: branchName,
    headRefPresent: true,
    headRepositoryFullName: 'DotNaos/project-space',
    headSha: setupSha,
    isCrossRepository: false,
    isDraft: true,
    linkedIssueNumbers: [494],
    number: 495,
    state: 'open',
    title: issue.title,
    url: 'https://github.com/DotNaos/project-space/pull/495',
    ...overrides
  };
}

function details(input: {
  branches?: GitHubBranchRecord[];
  pullRequests?: GitHubPullRequestRecord[];
} = {}): GitHubRepositoryDetailsResult {
  return {
    branches: [
      { commitSha: baseSha, isDefault: true, name: 'main' },
      ...(input.branches ?? [])
    ],
    checkedAt: '2026-08-07T18:00:00.000Z',
    issues: [issue],
    pullRequests: input.pullRequests ?? [],
    status: 'connected'
  };
}

function dependencies(
  overrides: Partial<GitHubIssueDevelopmentDependencies> = {}
): GitHubIssueDevelopmentDependencies {
  return {
    createBranch: async () => ({ branch: branch(), status: 'connected' }),
    createPullRequest: async () => ({ pullRequest: pullRequest(), status: 'connected' }),
    loadRepositoryDetails: async () => details(),
    requestGitHub: (async <Result>(path: string) => {
      if (path.includes('/compare/')) return { ahead_by: 0 } as Result;
      if (path.includes('/git/ref/heads/')) return { object: { sha: baseSha } } as Result;
      throw new Error(`Unexpected GitHub request: ${path}`);
    }) as GitHubIssueDevelopmentDependencies['requestGitHub'],
    resolveOAuthToken: async () => ({ source: 'stored-oauth', token: 'secret-token' }),
    ...overrides
  };
}

const request = {
  branchName,
  fullName: 'DotNaos/project-space',
  issueNumber: 494
};

describe('GitHub issue development start', () => {
  test('creates a linked branch without a bootstrap commit or draft pull request', async () => {
    const calls: Array<{ body?: unknown; method?: string; path: string }> = [];
    let pullRequestInput: unknown;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createPullRequest: async (input) => {
        pullRequestInput = input;
        return { pullRequest: pullRequest(), status: 'connected' };
      },
      requestGitHub: (async <Result>(path: string, _token: string, init?: RequestInit) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          method: init?.method,
          path
        });
        if (path.includes('/compare/')) return { ahead_by: 0 } as Result;
        if (path.includes('/git/ref/heads/')) return { object: { sha: baseSha } } as Result;
        throw new Error(`Unexpected GitHub request: ${path}`);
      }) as GitHubIssueDevelopmentDependencies['requestGitHub']
    }));

    expect(result).toMatchObject({
      branch: { commitSha: baseSha, name: branchName },
      branchDisposition: 'created',
      message: expect.stringContaining('after the first real commit'),
      state: 'ready',
      status: 'connected'
    });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      [undefined, `/repos/DotNaos/project-space/git/ref/heads/${branchName}`],
      [undefined, `/repos/DotNaos/project-space/compare/main...${branchName}`]
    ]);
    expect(calls.every((call) => call.method === undefined)).toBe(true);
    expect(pullRequestInput).toBeUndefined();
    expect(result).not.toHaveProperty('pullRequest');
  });

  test('reuses an existing verified pull request without writing to GitHub', async () => {
    let writes = 0;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createBranch: async () => {
        writes += 1;
        return { status: 'error' };
      },
      createPullRequest: async () => {
        writes += 1;
        return { status: 'error' };
      },
      loadRepositoryDetails: async () => details({
        branches: [branch({ commitSha: setupSha })],
        pullRequests: [pullRequest()]
      }),
      requestGitHub: (async () => {
        writes += 1;
        return {};
      }) as GitHubIssueDevelopmentDependencies['requestGitHub']
    }));

    expect(writes).toBe(0);
    expect(result).toMatchObject({
      branchDisposition: 'reused',
      pullRequestDisposition: 'reused',
      state: 'ready'
    });
  });

  test('returns a recoverable partial result when the branch exists but PR creation fails', async () => {
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createPullRequest: async () => ({ message: 'GitHub is temporarily unavailable.', status: 'error' }),
      loadRepositoryDetails: async () => details({ branches: [branch({ commitSha: setupSha })] }),
      requestGitHub: (async <Result>(path: string) => {
        if (path.includes('/git/ref/heads/')) return { object: { sha: setupSha } } as Result;
        if (path.includes('/compare/')) return { ahead_by: 1 } as Result;
        throw new Error(`Unexpected GitHub request: ${path}`);
      }) as GitHubIssueDevelopmentDependencies['requestGitHub']
    }));

    expect(result).toMatchObject({
      branch: { name: branchName },
      branchDisposition: 'reused',
      message: 'GitHub is temporarily unavailable.',
      state: 'partial',
      status: 'error'
    });
  });

  test('reconciles a pull request created despite a lost mutation response', async () => {
    let loads = 0;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createPullRequest: async () => ({ message: 'Request timed out.', status: 'error' }),
      loadRepositoryDetails: async () => {
        loads += 1;
        return details({
          branches: [branch({ commitSha: setupSha })],
          pullRequests: loads > 1 ? [pullRequest()] : []
        });
      },
      requestGitHub: (async <Result>(path: string) => {
        if (path.includes('/git/ref/heads/')) return { object: { sha: setupSha } } as Result;
        if (path.includes('/compare/')) return { ahead_by: 1 } as Result;
        throw new Error(`Unexpected GitHub request: ${path}`);
      }) as GitHubIssueDevelopmentDependencies['requestGitHub']
    }));

    expect(result).toMatchObject({
      pullRequestDisposition: 'reused',
      state: 'ready',
      status: 'connected'
    });
  });

  test('blocks ambiguous linked resources without creating anything', async () => {
    let writes = 0;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createBranch: async () => {
        writes += 1;
        return { status: 'error' };
      },
      createPullRequest: async () => {
        writes += 1;
        return { status: 'error' };
      },
      loadRepositoryDetails: async () => details({
        branches: [branch(), branch({ name: `${branchName}-other` })]
      })
    }));

    expect(writes).toBe(0);
    expect(result).toMatchObject({
      message: 'Multiple branches are linked. Choose one on GitHub before continuing.',
      state: 'blocked'
    });
  });

  test('preserves disconnected and authentication-required states without writing', async () => {
    for (const status of ['auth-required', 'disconnected'] as const) {
      let writes = 0;
      const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
        createBranch: async () => {
          writes += 1;
          return { status: 'error' };
        },
        createPullRequest: async () => {
          writes += 1;
          return { status: 'error' };
        },
        loadRepositoryDetails: async () => ({
          branches: [],
          issues: [],
          message: status === 'auth-required' ? 'Connect GitHub.' : 'GitHub is unavailable.',
          pullRequests: [],
          status
        })
      }));

      expect(writes).toBe(0);
      expect(result).toMatchObject({ state: 'blocked', status });
    }
  });

  test('blocks an open pull request whose draft state is stale or unverified', async () => {
    let writes = 0;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createPullRequest: async () => {
        writes += 1;
        return { status: 'error' };
      },
      loadRepositoryDetails: async () => details({
        branches: [branch({ commitSha: setupSha })],
        pullRequests: [pullRequest({ isDraft: undefined })]
      })
    }));

    expect(writes).toBe(0);
    expect(result).toMatchObject({
      message: 'The linked pull request draft state could not be verified.',
      state: 'blocked'
    });
  });

  test('reuses a verified same-head pull request before issue-link metadata catches up', async () => {
    let writes = 0;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createPullRequest: async () => {
        writes += 1;
        return { status: 'error' };
      },
      loadRepositoryDetails: async () => details({
        branches: [branch({ commitSha: setupSha })],
        pullRequests: [pullRequest({ linkedIssueNumbers: [] })]
      })
    }));

    expect(writes).toBe(0);
    expect(result).toMatchObject({
      pullRequestDisposition: 'reused',
      state: 'ready'
    });
  });

  test('blocks a linked pull request that does not target the default branch', async () => {
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      loadRepositoryDetails: async () => details({
        branches: [branch({ commitSha: setupSha })],
        pullRequests: [pullRequest({ baseBranch: 'release' })]
      })
    }));

    expect(result).toMatchObject({
      message: 'The linked pull request does not target the repository default branch.',
      state: 'blocked'
    });
  });

  test('does not claim success from an unverified create response', async () => {
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createPullRequest: async () => ({
        pullRequest: pullRequest({ isDraft: false }),
        status: 'connected'
      }),
      loadRepositoryDetails: async () => details({ branches: [branch({ commitSha: setupSha })] }),
      requestGitHub: (async <Result>(path: string) => {
        if (path.includes('/git/ref/heads/')) return { object: { sha: setupSha } } as Result;
        if (path.includes('/compare/')) return { ahead_by: 1 } as Result;
        throw new Error(`Unexpected GitHub request: ${path}`);
      }) as GitHubIssueDevelopmentDependencies['requestGitHub']
    }));

    expect(result).toMatchObject({
      message: 'GitHub did not return a verified draft pull request on the default branch.',
      state: 'partial'
    });
  });

  test('keeps an unchanged existing branch active without opening a pull request', async () => {
    let pullRequestWrites = 0;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createPullRequest: async () => {
        pullRequestWrites += 1;
        return { status: 'error' };
      },
      loadRepositoryDetails: async () => details({ branches: [branch()] }),
      requestGitHub: (async <Result>(path: string) => {
        if (path.includes('/compare/')) return { ahead_by: 0 } as Result;
        if (path.includes('/git/ref/heads/')) return { object: { sha: baseSha } } as Result;
        throw new Error(`Unexpected GitHub request: ${path}`);
      }) as GitHubIssueDevelopmentDependencies['requestGitHub']
    }));

    expect(result).toMatchObject({
      branchDisposition: 'reused',
      message: expect.stringContaining('after the first real commit'),
      state: 'ready',
      status: 'connected'
    });
    expect(pullRequestWrites).toBe(0);
    expect(result).not.toHaveProperty('pullRequest');
  });

  test('blocks an open issue that already has a merged linked pull request', async () => {
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      loadRepositoryDetails: async () => details({
        branches: [branch({ commitSha: setupSha })],
        pullRequests: [pullRequest({ state: 'merged' })]
      })
    }));

    expect(result).toMatchObject({
      message: expect.stringContaining('is merged, but issue #494 is still open'),
      state: 'blocked'
    });
  });

  test('safely reuses an existing ready-for-review pull request', async () => {
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      loadRepositoryDetails: async () => details({
        branches: [branch({ commitSha: setupSha })],
        pullRequests: [pullRequest({ isDraft: false })]
      })
    }));

    expect(result).toMatchObject({
      pullRequest: { isDraft: false },
      pullRequestDisposition: 'reused',
      state: 'ready'
    });
  });

  test('blocks a closed issue without creating new resources', async () => {
    let writes = 0;
    const result = await startGitHubIssueDevelopmentWithDependencies(request, dependencies({
      createBranch: async () => {
        writes += 1;
        return { status: 'error' };
      },
      loadRepositoryDetails: async () => ({
        ...details(),
        issues: [{ ...issue, state: 'closed' }]
      })
    }));

    expect(writes).toBe(0);
    expect(result).toMatchObject({
      message: 'Issue #494 is closed. Reopen it before starting development.',
      state: 'blocked'
    });
  });
});
