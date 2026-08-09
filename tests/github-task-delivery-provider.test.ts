import { describe, expect, test } from 'bun:test';

import { createGitHubTaskDeliveryProvider } from '../server/task-delivery/github-provider';
import { GitHubRequestError } from '../server/local-github-catalog';
import { taskDeliveryReviewRequestFingerprint } from '../server/task-delivery/review-fingerprint';
import type {
  GitHubApiPullRequest,
  GitHubProviderRequest
} from '../server/task-delivery/github-provider-observation';

const head = 'a'.repeat(40);
const mergeCommit = 'b'.repeat(40);
const oldHead = 'c'.repeat(40);
const observedAt = '2026-08-09T12:00:00.000Z';
const target = {
  branch: 'issue-562-delivery',
  providerKind: 'github',
  repositoryId: '42',
  taskId: 'github:DotNaos/project-space:562'
};

function fixture(options: {
  detailsLink?: boolean;
  issueState?: 'closed' | 'open';
  pullRequest?: GitHubApiPullRequest;
  requiredChecks?: 'unavailable' | 'unconfirmed-404' | 'unprotected' | {
    checks?: Array<{ app_id?: number | null; context: string }>;
    contexts?: string[];
  };
  checkRuns?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  reviewThreadPages?: 'error' | Array<{
    endCursor?: string | null;
    hasNextPage: boolean;
    nodes: Array<{ isResolved: boolean }>;
  }>;
} = {}) {
  let issueState = options.issueState ?? 'open';
  let pullRequest = options.pullRequest;
  const reviews = [...(options.reviews ?? [{
    commit_id: head, id: 21, state: 'APPROVED', submitted_at: observedAt,
    user: { id: 9, login: 'reviewer' }
  }])];
  const requests: Array<{ body?: string; method: string; path: string }> = [];
  let failMergeAfterDispatch = false;
  let mergeVisibilityDelay = 0;
  let mergeAwaitingVisibility = false;
  let failCreateAfterDispatch = false;
  let failCloseAfterDispatch = false;
  let failReviewAfterDispatch = false;
  const graphqlRequests: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const repository = {
    defaultBranch: 'main', description: undefined, fullName: 'DotNaos/project-space', id: 42,
    isPrivate: true, name: 'project-space', owner: 'DotNaos',
    projectConfig: { projectYaml: true, status: 'complete' as const, templateLock: true },
    url: 'https://github.com/DotNaos/project-space'
  };
  const details = () => ({
    branches: [{ commitSha: head, isDefault: false, linkedIssueNumbers: [562], name: target.branch }],
    checkedAt: observedAt,
    issues: [{ labels: [], number: 562, state: issueState, title: 'Delivery', url: 'https://github.com/DotNaos/project-space/issues/562' }],
    pullRequests: pullRequest ? [{
      baseBranch: 'main', headBranch: target.branch, headRepositoryFullName: repository.fullName,
      headSha: pullRequest.head?.sha ?? undefined, isDraft: pullRequest.draft ?? undefined,
      linkedIssueNumbers: options.detailsLink === false ? [] : [562],
      mergeCommitHash: pullRequest.merge_commit_sha ?? undefined,
      number: pullRequest.number, state: pullRequest.merged ? 'merged' as const : pullRequest.state,
      title: pullRequest.title ?? 'Delivery', url: pullRequest.html_url ?? 'https://github.com/DotNaos/project-space/pull/7'
    }] : [],
    status: 'connected' as const
  });
  const request: GitHubProviderRequest = async <T>(path: string, _token: string, init: RequestInit = {}) => {
    requests.push({ body: typeof init.body === 'string' ? init.body : undefined, method: init.method ?? 'GET', path });
    if (path.includes('/git/ref/heads/')) return { object: { sha: head } } as T;
    if (path.includes('/protection/required_status_checks')) {
      if (options.requiredChecks === 'unprotected' || options.requiredChecks === 'unconfirmed-404') {
        throw new GitHubRequestError(404, false);
      }
      if (options.requiredChecks === 'unavailable') throw new Error('secret protection response');
      return (options.requiredChecks ?? { contexts: ['quality'], checks: [] }) as T;
    }
    if (/\/branches\/main$/.test(path)) {
      if (options.requiredChecks === 'unconfirmed-404') throw new Error('secret branch response');
      return { protected: false } as T;
    }
    if (path.includes(`/commits/${head}/check-runs`)) return {
      check_runs: options.checkRuns ?? [{ completed_at: observedAt, conclusion: 'success', html_url: 'https://checks.example.test/run/1?token=hidden', id: 11, name: 'quality', status: 'completed' }],
      total_count: options.checkRuns?.length ?? 1
    } as T;
    if (path.includes(`/commits/${head}/status`)) return { statuses: [] } as T;
    if (path.includes('/reviews?')) return reviews as T;
    if (path.endsWith('/reviews') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { body: string; commit_id: string };
      reviews.push({ body: body.body, commit_id: body.commit_id, id: 30, state: 'COMMENT', submitted_at: observedAt, user: { id: 1 } });
      if (failReviewAfterDispatch) throw new Error('secret review response token');
      return { id: 30 } as T;
    }
    if (path.endsWith('/merge') && init.method === 'PUT') {
      if (mergeVisibilityDelay > 0) mergeAwaitingVisibility = true;
      else pullRequest = { ...pullRequest!, merge_commit_sha: mergeCommit, merged: true, state: 'closed' };
      if (failMergeAfterDispatch) throw new Error('secret merge response token');
      return { merged: true, sha: mergeCommit } as T;
    }
    if (path.endsWith('/pulls') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { body: string; draft: boolean; title: string };
      pullRequest = pr({ body: body.body, draft: body.draft, title: body.title });
      if (failCreateAfterDispatch) throw new Error('secret create response token');
      return pullRequest as T;
    }
    if (path.includes('/issues/562') && init.method === 'PATCH') {
      issueState = 'closed';
      if (failCloseAfterDispatch) throw new Error('secret close response token');
      return { state: 'closed' } as T;
    }
    if (/\/pulls\/\d+$/.test(path)) {
      if (mergeAwaitingVisibility) {
        if (mergeVisibilityDelay > 0) mergeVisibilityDelay -= 1;
        else {
          pullRequest = { ...pullRequest!, merge_commit_sha: mergeCommit, merged: true, state: 'closed' };
          mergeAwaitingVisibility = false;
        }
      }
      return pullRequest as T;
    }
    if (path.includes('/pulls?')) return (pullRequest ? [pullRequest] : []) as T;
    throw new Error(`Unexpected request: ${path}`);
  };
  const provider = createGitHubTaskDeliveryProvider({
    backend: {
      async getDeployedEnvironmentStatus() {
        return {
          checkedAt: observedAt,
          environments: [{
            deployedSha: mergeCommit, deployedVersion: '3.4.0', displayName: 'Production', id: 'prod',
            liveUrl: 'https://projects.example.test/', liveUrlState: 'available' as const,
            verification: 'healthy' as const, verifiedAt: observedAt
          }],
          repositoryFullName: repository.fullName,
          status: 'available' as const
        };
      },
      async getGitHubCatalog() {
        return { checkedAt: observedAt, repositories: [repository], status: 'connected' as const };
      },
      async getGitHubRepositoryDetails() { return details(); }
    },
    now: () => observedAt,
    requestGitHub: request,
    requestGitHubGraphQL: async (_token, query, variables) => {
      graphqlRequests.push({ query, variables });
      if (query.includes('reviewThreads')) {
        if (options.reviewThreadPages === 'error') throw new Error('secret review-thread response');
        const pages = options.reviewThreadPages ?? [{ hasNextPage: false, nodes: [] }];
        const after = variables.after;
        const pageIndex = after === null
          ? 0
          : pages.findIndex((page) => page.endCursor === after) + 1;
        const page = pages[pageIndex];
        if (!page) return { repository: { pullRequest: { reviewThreads: undefined } } };
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: page.nodes,
                pageInfo: { endCursor: page.endCursor ?? null, hasNextPage: page.hasNextPage }
              }
            }
          }
        };
      }
      return {};
    },
    resolveOAuthToken: async () => ({ token: 'never-exposed' })
  });
  return {
    failClose() { failCloseAfterDispatch = true; },
    failCreate() { failCreateAfterDispatch = true; },
    failMerge(visibilityDelay = 0) {
      failMergeAfterDispatch = true;
      mergeVisibilityDelay = visibilityDelay;
    },
    failReview() { failReviewAfterDispatch = true; },
    graphqlRequests,
    provider,
    requests
  };
}

function pr(overrides: Partial<GitHubApiPullRequest> = {}): GitHubApiPullRequest {
  return {
    base: { ref: 'main' }, body: 'Refs #562\n\n<!-- project-space-task:562 -->', draft: false,
    head: { ref: target.branch, repo: { full_name: 'DotNaos/project-space' }, sha: head },
    html_url: 'https://github.com/DotNaos/project-space/pull/7', node_id: 'PR_node',
    number: 7, state: 'open', title: 'Delivery', ...overrides
  };
}

describe('GitHub Task delivery provider', () => {
  test('observes exact-head required checks, reviews, and sanitized deployment version', async () => {
    const { provider } = fixture({ pullRequest: pr() });
    const result = await provider.observe(target);
    expect(result).toMatchObject({
      checks: { commit: head, required: [{ id: 'check-run:11', name: 'quality', state: 'passing' }], state: 'passing' },
      deployment: { deployedCommit: mergeCommit, environment: 'prod', runningVersion: '3.4.0' },
      pullRequest: { baseBranch: 'main', headCommit: head, number: 7, state: 'open' },
      review: { commit: head, state: 'approved' }, sourceCommit: head, taskState: 'open'
    });
    expect(result.checks.required[0]?.url).toBe('https://checks.example.test/run/1');
    expect(JSON.stringify(result)).not.toContain('token=hidden');
  });

  test('blocks merge when approval belongs to an older head', async () => {
    const { provider, requests } = fixture({
      pullRequest: pr(),
      reviews: [{ commit_id: oldHead, id: 21, state: 'APPROVED', submitted_at: observedAt, user: { id: 9 } }]
    });
    expect(await provider.merge({ expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target }))
      .toEqual({ kind: 'blocked', reason: 'approval_required' });
    expect(requests.some((request) => request.path.endsWith('/merge'))).toBe(false);
  });

  test('reconciles a lost merge response without dispatching merge twice', async () => {
    const setup = fixture({ pullRequest: pr() });
    setup.failMerge();
    const result = await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    });
    expect(result).toMatchObject({ kind: 'confirmed', observation: { mergeCommit, pullRequest: { state: 'merged' } } });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('reconciles an eventually visible merge after a lost response', async () => {
    const setup = fixture({ pullRequest: pr() });
    setup.failMerge(2);
    const result = await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    });
    expect(result).toMatchObject({ kind: 'confirmed', observation: { mergeCommit, pullRequest: { state: 'merged' } } });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(1);
  });

  test('returns authoritative evidence from a confirmed merge response', async () => {
    const setup = fixture({ pullRequest: pr() });
    const result = await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    });
    expect(result).toMatchObject({
      kind: 'confirmed',
      observation: {
        checks: { commit: head, state: 'passing' },
        mergeCommit,
        pullRequest: { baseBranch: 'main', headCommit: head, number: 7, state: 'merged' },
        review: { commit: head, state: 'approved' },
        sourceCommit: head,
        taskState: 'open'
      }
    });
  });

  test('replays an already merged exact pull request without another merge request', async () => {
    const setup = fixture({
      pullRequest: pr({ merge_commit_sha: mergeCommit, merged: true, state: 'closed' })
    });
    const result = await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    });
    expect(result).toMatchObject({ kind: 'confirmed', observation: { mergeCommit, pullRequest: { state: 'merged' } } });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
  });

  test('reconciles a lost pull-request create response by exact branch, task, and presentation', async () => {
    const setup = fixture();
    setup.failCreate();
    const result = await setup.provider.createOrUpdatePullRequest({
      body: 'Ready for review.', draft: true, expectedHeadCommit: head, title: 'Delivery', target
    });
    expect(result).toMatchObject({ kind: 'confirmed', observation: { pullRequest: { draft: true, headCommit: head } } });
    expect(setup.requests.filter((request) => request.path.endsWith('/pulls') && request.method === 'POST'))
      .toHaveLength(1);
    const creation = setup.requests.find((request) => request.path.endsWith('/pulls') && request.method === 'POST');
    const body = JSON.parse(creation?.body ?? '{}') as { body?: string };
    expect(body.body).toContain('Refs #562');
    expect(body.body).toContain('<!-- project-space-task:562 -->');
    expect(body.body).not.toMatch(/closes\s+#562/i);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('updates the bound pull request and marks the exact revision ready for review', async () => {
    const setup = fixture({ pullRequest: pr({ draft: true }) });
    const result = await setup.provider.createOrUpdatePullRequest({
      body: 'Updated summary.', draft: false, expectedHeadCommit: head, title: 'Updated delivery', target
    });
    expect(result).toMatchObject({ kind: 'confirmed', observation: { pullRequest: { draft: false, headCommit: head } } });
    expect(setup.requests.some((request) => /\/pulls\/7$/.test(request.path) && request.method === 'PATCH'))
      .toBe(true);
    expect(setup.graphqlRequests.some((request) => request.query.includes('markPullRequestReadyForReview')))
      .toBe(true);
  });

  test('records a review request as a comment on the exact pull-request revision', async () => {
    const setup = fixture({ pullRequest: pr() });
    const result = await setup.provider.requestReview({
      expectedHeadCommit: head, pullRequestNumber: 7, summary: 'Please review the delivery.', target
    });
    expect(result.kind).toBe('confirmed');
    const review = setup.requests.find((request) => request.path.endsWith('/pulls/7/reviews'));
    expect(review?.method).toBe('POST');
    const reviewBody = JSON.parse(review?.body ?? '{}') as Record<string, string>;
    expect(reviewBody).toMatchObject({ commit_id: head, event: 'COMMENT' });
    expect(reviewBody.body).toContain('Please review the delivery.');
    expect(reviewBody.body).toMatch(/<!-- project-space-review-request:[0-9a-f]{64} -->/);
  });

  test('reconciles a lost review-request response and does not create a duplicate comment', async () => {
    const setup = fixture({ pullRequest: pr() });
    setup.failReview();
    const request = {
      expectedHeadCommit: head, pullRequestNumber: 7, summary: 'Please review the delivery.', target
    };
    const first = await setup.provider.requestReview(request);
    const replay = await setup.provider.requestReview(request);
    expect(first.kind).toBe('confirmed');
    expect(replay.kind).toBe('confirmed');
    const expectedFingerprint = taskDeliveryReviewRequestFingerprint({
      headCommit: head,
      summary: request.summary
    });
    if (first.kind === 'confirmed') {
      expect(first.observation.review.requestFingerprint).toBe(expectedFingerprint);
    }
    if (replay.kind === 'confirmed') {
      expect(replay.observation.review.requestFingerprint).toBe(expectedFingerprint);
    }
    expect(setup.requests.filter((entry) => entry.path.endsWith('/pulls/7/reviews') && entry.method === 'POST'))
      .toHaveLength(1);
    expect(JSON.stringify([first, replay])).not.toContain('secret');
  });

  test('does not bind a pull request whose base is not the repository default branch', async () => {
    const setup = fixture({ pullRequest: pr({ base: { ref: 'staging' } }) });
    expect((await setup.provider.observe(target)).pullRequest).toBeUndefined();
    expect(await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    })).toEqual({ kind: 'blocked', reason: 'pull_request_missing' });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
  });

  test('does not bind a pull request that only closes the same Task number in another repository', async () => {
    const foreign = fixture({
      detailsLink: false,
      pullRequest: pr({ body: 'Closes other/repository#562' })
    });
    expect((await foreign.provider.observe(target)).pullRequest).toBeUndefined();

    const current = fixture({
      detailsLink: false,
      pullRequest: pr({ body: 'Fixes DotNaos/project-space#562' })
    });
    expect((await current.provider.observe(target)).pullRequest?.number).toBe(7);

    const unqualified = fixture({
      detailsLink: false,
      pullRequest: pr({ body: 'Resolves #562' })
    });
    expect((await unqualified.provider.observe(target)).pullRequest?.number).toBe(7);
  });

  test('treats a confirmed unprotected default branch as having no required checks', async () => {
    const setup = fixture({ pullRequest: pr(), requiredChecks: 'unprotected' });
    const observation = await setup.provider.observe(target);
    expect(observation.checks).toMatchObject({ commit: head, required: [], state: 'passing' });
    expect(await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    })).toMatchObject({ kind: 'confirmed' });
  });

  test('fails closed when branch-protection evidence is unavailable', async () => {
    const setup = fixture({ pullRequest: pr(), requiredChecks: 'unavailable' });
    const observation = await setup.provider.observe(target);
    expect(observation.checks.state).toBe('unavailable');
    expect(await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    })).toEqual({ kind: 'blocked', reason: 'checks_unverified' });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
    expect(JSON.stringify(observation)).not.toContain('secret');
  });

  test('does not treat an unconfirmed protection 404 as an unprotected branch', async () => {
    const setup = fixture({ pullRequest: pr(), requiredChecks: 'unconfirmed-404' });
    const observation = await setup.provider.observe(target);
    expect(observation.checks.state).toBe('unavailable');
    expect(await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    })).toEqual({ kind: 'blocked', reason: 'checks_unverified' });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
    expect(JSON.stringify(observation)).not.toContain('secret');
  });

  test('preserves required check app identity and rejects a same-name check from another app', async () => {
    const setup = fixture({
      checkRuns: [{
        app: { id: 98 }, completed_at: observedAt, conclusion: 'success', id: 11,
        name: 'quality', status: 'completed'
      }],
      pullRequest: pr(),
      requiredChecks: { checks: [{ app_id: 99, context: 'quality' }], contexts: ['quality'] }
    });
    const observation = await setup.provider.observe(target);
    expect(observation.checks).toMatchObject({
      required: [{ name: 'quality', requiredAppId: 99, state: 'pending' }], state: 'pending'
    });
    expect(await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    })).toEqual({ kind: 'blocked', reason: 'checks_pending' });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
  });

  test('blocks an approved green pull request while one review thread is unresolved', async () => {
    const setup = fixture({
      pullRequest: pr(),
      reviewThreadPages: [{ hasNextPage: false, nodes: [{ isResolved: false }] }]
    });
    expect(await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    })).toEqual({ kind: 'blocked', reason: 'unresolved_review' });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
  });

  test('fully paginates review threads and allows merge only with an explicit zero count', async () => {
    const setup = fixture({
      pullRequest: pr(),
      reviewThreadPages: [
        { endCursor: 'review-thread-page-1', hasNextPage: true, nodes: [{ isResolved: true }] },
        { hasNextPage: false, nodes: [{ isResolved: true }] }
      ]
    });
    const result = await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    });
    expect(result).toMatchObject({
      kind: 'confirmed', observation: { review: { unresolvedThreads: 0 } }
    });
    expect(setup.graphqlRequests.filter((request) => request.query.includes('reviewThreads')))
      .toHaveLength(2);
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(1);
  });

  test('fails closed when review-thread evidence is unavailable', async () => {
    const setup = fixture({ pullRequest: pr(), reviewThreadPages: 'error' });
    const result = await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    });
    expect(result).toEqual({ kind: 'blocked', reason: 'approval_stale' });
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('fails closed when review-thread pagination exceeds the bounded read', async () => {
    const setup = fixture({
      pullRequest: pr(),
      reviewThreadPages: Array.from({ length: 5 }, (_, index) => ({
        endCursor: `review-thread-page-${index + 1}`,
        hasNextPage: true,
        nodes: [{ isResolved: true }]
      }))
    });
    expect(await setup.provider.merge({
      expectedHeadCommit: head, method: 'squash', pullRequestNumber: 7, target
    })).toEqual({ kind: 'blocked', reason: 'approval_stale' });
    expect(setup.graphqlRequests.filter((request) => request.query.includes('reviewThreads')))
      .toHaveLength(5);
    expect(setup.requests.filter((request) => request.path.endsWith('/merge'))).toHaveLength(0);
  });

  test('reconciles a lost Task-close response through a fresh owner-authorized read', async () => {
    const setup = fixture({ pullRequest: pr({ merged: true, state: 'closed', merge_commit_sha: mergeCommit }) });
    setup.failClose();
    const result = await setup.provider.completeTask({ expectedState: 'open', target });
    expect(result).toMatchObject({ kind: 'confirmed', observation: { taskState: 'completed' } });
    expect(setup.requests.filter((request) => request.path.includes('/issues/562') && request.method === 'PATCH'))
      .toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('does not make raw GitHub calls when the repository is not owner-authorized', async () => {
    let rawCalls = 0;
    const provider = createGitHubTaskDeliveryProvider({
      backend: {
        async getDeployedEnvironmentStatus() {
          return { checkedAt: observedAt, environments: [], repositoryFullName: 'private/repo', status: 'unauthorized' as const };
        },
        async getGitHubCatalog() {
          return { checkedAt: observedAt, repositories: [], status: 'connected' as const };
        },
        async getGitHubRepositoryDetails() {
          throw new Error('must not be reached');
        }
      },
      requestGitHub: async <T>() => { rawCalls += 1; return {} as T; },
      requestGitHubGraphQL: async () => ({}),
      resolveOAuthToken: async () => ({ token: 'secret' })
    });
    expect(await provider.createOrUpdatePullRequest({
      draft: true, expectedHeadCommit: head, title: 'No access', target
    })).toEqual({ kind: 'blocked', reason: 'target_unavailable' });
    expect(rawCalls).toBe(0);
  });
});
