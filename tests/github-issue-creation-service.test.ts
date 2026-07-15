import { describe, expect, test } from 'bun:test';

import {
  createIdempotentGitHubIssue,
  gitHubIssueCreationMarker,
  stripGitHubIssueCreationMarker,
  type GitHubIssueCreationRemote
} from '../server/github-issue-creation-service';
import { MemoryGitHubIssueCreationOperationStore } from '../server/github-issue-creation-operation-store';
import type { GitHubIssueCreateRequest, GitHubIssueRecord } from '../src/shared/project-space-api';

const operationId = '00000000-0000-4000-8000-000000000187';
const repository = 'DotNaos/project-space';
const userId = 'user-cata';

function request(overrides: Partial<GitHubIssueCreateRequest> = {}): GitHubIssueCreateRequest {
  return {
    body: 'Description',
    fullName: repository,
    labels: ['bug'],
    operationId,
    title: 'Create issue modal',
    ...overrides
  };
}

function issue(overrides: Partial<GitHubIssueRecord> = {}): GitHubIssueRecord {
  return {
    body: 'Description',
    labels: ['bug'],
    number: 187,
    state: 'open',
    title: 'Create issue modal',
    url: 'https://github.com/DotNaos/project-space/issues/187',
    ...overrides
  };
}

function remote(overrides: Partial<GitHubIssueCreationRemote> = {}) {
  return {
    create: async () => issue(),
    findByMarker: async () => [],
    isRetrySafeError: () => false,
    ...overrides
  } satisfies GitHubIssueCreationRemote;
}

describe('duplicate-safe GitHub issue creation', () => {
  test('stores a completed operation and replays it without another POST', async () => {
    const store = new MemoryGitHubIssueCreationOperationStore();
    const postedBodies: string[] = [];
    const github = remote({
      create: async (input) => {
        postedBodies.push(input.body);
        return issue({ body: input.body });
      }
    });
    const options = { remote: github, request: request(), store, userId };

    expect(await createIdempotentGitHubIssue(options)).toMatchObject({
      creationState: 'complete',
      issue: { body: 'Description', number: 187 },
      status: 'connected'
    });
    expect(await createIdempotentGitHubIssue(options)).toMatchObject({
      creationState: 'complete',
      issue: { body: 'Description' },
      replayed: true,
      status: 'connected'
    });
    expect(postedBodies).toEqual([
      `Description\n\n${gitHubIssueCreationMarker(operationId)}`
    ]);
  });

  test('strips a legacy stored marker before replaying an operation to the browser', async () => {
    const marker = gitHubIssueCreationMarker(operationId);
    const result = await createIdempotentGitHubIssue({
      remote: remote(),
      request: request(),
      store: {
        async complete() {},
        async markAmbiguous() {},
        async markRetryable() {},
        async reserve() {
          return {
            issue: issue({ body: `Description\n\n${marker}` }),
            kind: 'replayed' as const
          };
        }
      },
      userId
    });

    expect(result).toMatchObject({ issue: { body: 'Description' }, replayed: true });
  });

  test('reconciles a lost success response by its exact hidden marker', async () => {
    const store = new MemoryGitHubIssueCreationOperationStore();
    const storedIssues: GitHubIssueRecord[] = [];
    let posts = 0;
    const github = remote({
      create: async (input) => {
        posts += 1;
        storedIssues.push(issue({ body: input.body }));
        throw new Error('Connection ended before GitHub replied.');
      },
      findByMarker: async (_fullName, marker) => storedIssues
        .filter((candidate) => candidate.body?.includes(marker))
        .map((candidate) => ({
          ...candidate,
          body: stripGitHubIssueCreationMarker(candidate.body ?? '')
        }))
    });

    const result = await createIdempotentGitHubIssue({
      remote: github,
      request: request(),
      store,
      userId
    });
    expect(result).toMatchObject({
      creationState: 'complete',
      issue: { body: 'Description', number: 187 },
      replayed: true,
      status: 'connected'
    });
    expect(posts).toBe(1);

    await createIdempotentGitHubIssue({ remote: github, request: request(), store, userId });
    expect(posts).toBe(1);
  });

  test('never posts again while an ambiguous outcome has no matching issue', async () => {
    const store = new MemoryGitHubIssueCreationOperationStore();
    let posts = 0;
    let checks = 0;
    const github = remote({
      create: async () => {
        posts += 1;
        throw new Error('Network timeout');
      },
      findByMarker: async () => {
        checks += 1;
        return [];
      }
    });
    const options = { remote: github, request: request(), store, userId };

    expect(await createIdempotentGitHubIssue(options)).toMatchObject({
      creationState: 'uncertain',
      status: 'error'
    });
    expect(await createIdempotentGitHubIssue(options)).toMatchObject({
      creationState: 'uncertain',
      status: 'error'
    });
    expect({ checks, posts }).toEqual({ checks: 3, posts: 1 });
  });

  test('recovers the same operation after a local store restart before posting', async () => {
    const remoteIssues: GitHubIssueRecord[] = [];
    let posts = 0;
    const github = remote({
      create: async (input) => {
        posts += 1;
        const created = issue({ body: input.body });
        remoteIssues.push(created);
        return issue();
      },
      findByMarker: async (_fullName, marker) => remoteIssues
        .filter((candidate) => candidate.body?.includes(marker))
        .map((candidate) => ({
          ...candidate,
          body: stripGitHubIssueCreationMarker(candidate.body ?? '')
        }))
    });
    await createIdempotentGitHubIssue({
      remote: github,
      request: request(),
      store: new MemoryGitHubIssueCreationOperationStore(),
      userId
    });
    const recovered = await createIdempotentGitHubIssue({
      remote: github,
      request: request(),
      store: new MemoryGitHubIssueCreationOperationStore(),
      userId
    });

    expect(recovered).toMatchObject({
      creationState: 'complete',
      replayed: true,
      status: 'connected'
    });
    expect(posts).toBe(1);
  });

  test('does not post twice when the same operation arrives concurrently', async () => {
    const store = new MemoryGitHubIssueCreationOperationStore();
    let releaseCreate!: (value: GitHubIssueRecord) => void;
    const createResult = new Promise<GitHubIssueRecord>((resolve) => {
      releaseCreate = resolve;
    });
    let posts = 0;
    const github = remote({
      create: async () => {
        posts += 1;
        return createResult;
      }
    });
    const options = { remote: github, request: request(), store, userId };
    const first = createIdempotentGitHubIssue(options);
    await Promise.resolve();

    expect(await createIdempotentGitHubIssue(options)).toMatchObject({
      creationState: 'uncertain',
      status: 'error'
    });
    expect(posts).toBe(1);
    releaseCreate(issue());
    expect(await first).toMatchObject({ creationState: 'complete', status: 'connected' });
  });

  test('allows the same operation to retry only after a definitive rejection', async () => {
    class Rejected extends Error {}
    const store = new MemoryGitHubIssueCreationOperationStore();
    let attempts = 0;
    const github = remote({
      create: async () => {
        attempts += 1;
        if (attempts === 1) throw new Rejected('GitHub rejected the title.');
        return issue();
      },
      isRetrySafeError: (error) => error instanceof Rejected
    });
    const options = { remote: github, request: request(), store, userId };

    expect(await createIdempotentGitHubIssue(options)).toMatchObject({
      creationState: 'retryable',
      message: 'GitHub rejected the title.'
    });
    expect(await createIdempotentGitHubIssue(options)).toMatchObject({
      creationState: 'complete',
      status: 'connected'
    });
    expect(attempts).toBe(2);
  });

  test('scopes the operation identity to both account and repository', async () => {
    const store = new MemoryGitHubIssueCreationOperationStore();
    const posted: string[] = [];
    const github = remote({
      create: async (input) => {
        posted.push(input.fullName);
        return issue({ number: posted.length });
      }
    });

    await createIdempotentGitHubIssue({ remote: github, request: request(), store, userId });
    await createIdempotentGitHubIssue({
      remote: github,
      request: request({ fullName: 'DotNaos/another-repository' }),
      store,
      userId
    });
    await createIdempotentGitHubIssue({
      remote: github,
      request: request(),
      store,
      userId: 'another-user'
    });
    expect(posted).toEqual([
      repository,
      'DotNaos/another-repository',
      repository
    ]);
  });

  test('rejects changed input for an ambiguous operation id', async () => {
    const store = new MemoryGitHubIssueCreationOperationStore();
    let posts = 0;
    const github = remote({
      create: async () => {
        posts += 1;
        throw new Error('Network timeout');
      }
    });
    await createIdempotentGitHubIssue({ remote: github, request: request(), store, userId });
    const result = await createIdempotentGitHubIssue({
      remote: github,
      request: request({ title: 'A changed title' }),
      store,
      userId
    });
    expect(result).toMatchObject({ creationState: 'uncertain', status: 'error' });
    expect(result.message).toContain('different draft');
    expect(posts).toBe(1);
  });

  test('does not rotate or post when durable operation storage is unavailable', async () => {
    let posts = 0;
    const github = remote({
      create: async () => {
        posts += 1;
        return issue();
      }
    });
    const result = await createIdempotentGitHubIssue({
      remote: github,
      request: request(),
      store: {
        async complete() {},
        async markAmbiguous() {},
        async markRetryable() {},
        async reserve() { throw new Error('database unavailable'); }
      },
      userId
    });

    expect(result).toMatchObject({ creationState: 'uncertain', status: 'error' });
    expect(result.message).toContain('Nothing new was sent');
    expect(posts).toBe(0);
  });
});
