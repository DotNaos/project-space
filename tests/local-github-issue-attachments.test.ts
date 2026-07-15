import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  uploadLocalGitHubIssueAttachment,
  type LocalGitHubIssueAttachmentDependencies,
  type LocalGitHubIssueAttachmentRequest
} from '../server/local-github-issue-attachments';

const REPOSITORY = 'DotNaos/project-space';
const ISSUE_NUMBER = 187;
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000001';
const IMAGE_BYTES = Buffer.from('validated-image-bytes');
const DEFAULT_SHA = 'd'.repeat(40);
const BRANCH_SHA = 'b'.repeat(40);
const BRANCH_NAME = `project-space-issue-${ISSUE_NUMBER}-attachments`;
const BRANCH_REF = `refs/heads/${BRANCH_NAME}`;
const EXPECTED_PATH =
  `.github/project-space/issue-attachments/${ISSUE_NUMBER}/${ATTACHMENT_ID}.png`;

function blobSha(bytes: Uint8Array) {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

function request(
  overrides: Partial<LocalGitHubIssueAttachmentRequest> = {}
): LocalGitHubIssueAttachmentRequest {
  return {
    attachmentId: ATTACHMENT_ID,
    bytes: IMAGE_BYTES,
    declaredMediaType: 'image/png',
    fullName: REPOSITORY,
    issueNumber: ISSUE_NUMBER,
    ...overrides
  };
}

function dependencies(
  requestGitHub: LocalGitHubIssueAttachmentDependencies['requestGitHub']
): LocalGitHubIssueAttachmentDependencies {
  return {
    getGitHubClientId: () => 'github-client',
    requestGitHub,
    async resolveOAuthToken() {
      return { token: 'server-only-token' };
    },
    async validateAttachment() {
      return { extension: 'png', height: 1, mediaType: 'image/png', width: 1 };
    }
  };
}

function repositoryResponse(push: boolean | undefined = true) {
  return {
    archived: false,
    default_branch: 'main',
    disabled: false,
    permissions: push === undefined ? undefined : { push }
  };
}

describe('local GitHub issue attachments', () => {
  test('creates a per-issue branch and writes only there with a server-chosen path', async () => {
    const calls: Array<{ init?: RequestInit; path: string; token: string }> = [];
    const result = await uploadLocalGitHubIssueAttachment(
      request(),
      dependencies(async <T>(path: string, token: string, init?: RequestInit) => {
        calls.push({ init, path, token });
        if (path === `/repos/${REPOSITORY}`) return repositoryResponse() as T;
        if (path === `/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
          return { number: ISSUE_NUMBER } as T;
        }
        if (path.endsWith(`/git/ref/heads/${BRANCH_NAME}`)) {
          throw new Error('GitHub request failed with 404.');
        }
        if (path.endsWith('/git/ref/heads/main')) {
          return { object: { sha: DEFAULT_SHA }, ref: 'refs/heads/main' } as T;
        }
        if (path.endsWith('/git/refs')) {
          return { object: { sha: DEFAULT_SHA }, ref: BRANCH_REF } as T;
        }
        return {
          commit: { sha: BRANCH_SHA },
          content: { path: EXPECTED_PATH, sha: blobSha(IMAGE_BYTES) }
        } as T;
      })
    );

    expect(calls.map(({ init, path }) => `${init?.method ?? 'GET'} ${path}`)).toEqual([
      `GET /repos/${REPOSITORY}`,
      `GET /repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
      `GET /repos/${REPOSITORY}/git/ref/heads/${BRANCH_NAME}`,
      `GET /repos/${REPOSITORY}/git/ref/heads/main`,
      `POST /repos/${REPOSITORY}/git/refs`,
      `PUT /repos/${REPOSITORY}/contents/${EXPECTED_PATH}`
    ]);
    const refPayload = JSON.parse(String(calls[4]?.init?.body));
    expect(refPayload).toEqual({ ref: BRANCH_REF, sha: DEFAULT_SHA });
    const contentPayload = JSON.parse(String(calls[5]?.init?.body));
    expect(contentPayload).toEqual({
      branch: BRANCH_NAME,
      content: IMAGE_BYTES.toString('base64'),
      message: `Add image for issue #${ISSUE_NUMBER}`
    });
    expect(calls[5]?.token).toBe('server-only-token');
    expect(result).toEqual({
      attachmentId: ATTACHMENT_ID,
      fullName: REPOSITORY,
      issueNumber: ISSUE_NUMBER,
      markdownUrl:
        `https://github.com/${REPOSITORY}/blob/${BRANCH_SHA}/${EXPECTED_PATH}?raw=1`,
      mediaType: 'image/png',
      sizeBytes: IMAGE_BYTES.byteLength,
      status: 'connected'
    });
  });

  test('keeps a new issue branch after a failed write so concurrent uploads stay safe', async () => {
    const calls: Array<{ init?: RequestInit; path: string }> = [];
    let branchReads = 0;
    const result = await uploadLocalGitHubIssueAttachment(
      request(),
      dependencies(async <T>(path, _token, init) => {
        calls.push({ init, path });
        if (path === `/repos/${REPOSITORY}`) return repositoryResponse() as T;
        if (path === `/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
          return { number: ISSUE_NUMBER } as T;
        }
        if (path.endsWith(`/git/ref/heads/${BRANCH_NAME}`)) {
          branchReads += 1;
          if (branchReads === 1) throw new Error('GitHub request failed with 404.');
          return { object: { sha: DEFAULT_SHA }, ref: BRANCH_REF } as T;
        }
        if (path.endsWith('/git/ref/heads/main')) {
          return { object: { sha: DEFAULT_SHA }, ref: 'refs/heads/main' } as T;
        }
        if (path.endsWith('/git/refs') && init?.method === 'POST') {
          return { object: { sha: DEFAULT_SHA }, ref: BRANCH_REF } as T;
        }
        if (init?.method === 'PUT') {
          throw new Error('GitHub request failed with 500.');
        }
        if (path.includes('/contents/')) {
          throw new Error('GitHub request failed with 404.');
        }
        throw new Error(`Unexpected request: ${path}`);
      })
    );

    expect(result.status).toBe('error');
    expect(branchReads).toBe(2);
    expect(calls.some(({ init }) => init?.method === 'DELETE')).toBe(false);
  });

  test('reuses an existing per-issue branch and recovers an idempotent file retry', async () => {
    const calls: string[] = [];
    let branchReadCount = 0;
    const result = await uploadLocalGitHubIssueAttachment(
      request(),
      dependencies(async <T>(path, _token, init) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === `/repos/${REPOSITORY}`) return repositoryResponse() as T;
        if (path === `/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
          return { number: ISSUE_NUMBER } as T;
        }
        if (path.endsWith(`/git/ref/heads/${BRANCH_NAME}`)) {
          branchReadCount += 1;
          return {
            object: { sha: branchReadCount === 1 ? BRANCH_SHA : 'c'.repeat(40) },
            ref: BRANCH_REF
          } as T;
        }
        if (init?.method === 'PUT') {
          expect(JSON.parse(String(init.body)).branch).toBe(BRANCH_NAME);
          throw new Error('GitHub request failed with 422.');
        }
        return { path: EXPECTED_PATH, sha: blobSha(IMAGE_BYTES) } as T;
      })
    );

    expect(calls).toEqual([
      `GET /repos/${REPOSITORY}`,
      `GET /repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
      `GET /repos/${REPOSITORY}/git/ref/heads/${BRANCH_NAME}`,
      `PUT /repos/${REPOSITORY}/contents/${EXPECTED_PATH}`,
      `GET /repos/${REPOSITORY}/git/ref/heads/${BRANCH_NAME}`,
      `GET /repos/${REPOSITORY}/contents/${EXPECTED_PATH}?ref=${'c'.repeat(40)}`
    ]);
    expect(result).toMatchObject({
      markdownUrl:
        `https://github.com/${REPOSITORY}/blob/${'c'.repeat(40)}/${EXPECTED_PATH}?raw=1`,
      status: 'connected'
    });
  });

  test('recovers a concurrent branch creation without accepting a client branch', async () => {
    let branchReads = 0;
    const result = await uploadLocalGitHubIssueAttachment(
      request(),
      dependencies(async <T>(path, _token, init) => {
        if (path === `/repos/${REPOSITORY}`) return repositoryResponse() as T;
        if (path === `/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
          return { number: ISSUE_NUMBER } as T;
        }
        if (path.endsWith(`/git/ref/heads/${BRANCH_NAME}`)) {
          branchReads += 1;
          if (branchReads === 1) throw new Error('GitHub request failed with 404.');
          return { object: { sha: BRANCH_SHA }, ref: BRANCH_REF } as T;
        }
        if (path.endsWith('/git/ref/heads/main')) {
          return { object: { sha: DEFAULT_SHA }, ref: 'refs/heads/main' } as T;
        }
        if (path.endsWith('/git/refs')) {
          throw new Error('GitHub request failed with 422.');
        }
        if (init?.method === 'PUT') {
          return {
            commit: { sha: BRANCH_SHA },
            content: { path: EXPECTED_PATH, sha: blobSha(IMAGE_BYTES) }
          } as T;
        }
        throw new Error(`Unexpected request: ${path}`);
      })
    );

    expect(result.status).toBe('connected');
    expect(branchReads).toBe(2);
  });

  test('validates repository, issue, and attachment scope before credentials', async () => {
    let authCalls = 0;
    let githubCalls = 0;
    let validationCalls = 0;
    const deps: LocalGitHubIssueAttachmentDependencies = {
      getGitHubClientId: () => 'github-client',
      async requestGitHub<T>() {
        githubCalls += 1;
        return {} as T;
      },
      async resolveOAuthToken() {
        authCalls += 1;
        return { token: 'unused' };
      },
      async validateAttachment() {
        validationCalls += 1;
        return { extension: 'png', height: 1, mediaType: 'image/png', width: 1 };
      }
    };

    for (const item of [
      request({ fullName: '../secret' }),
      request({ attachmentId: '../../branch' }),
      request({ attachmentId: '00000000-0000-4000-8000-00000000000A' }),
      request({ issueNumber: 0 }),
      request({ issueNumber: Number.MAX_SAFE_INTEGER + 1 })
    ]) {
      expect((await uploadLocalGitHubIssueAttachment(item, deps)).status).toBe('error');
    }

    expect(authCalls).toBe(0);
    expect(githubCalls).toBe(0);
    expect(validationCalls).toBe(0);
  });

  test('reports GitHub connection states without sending image bytes', async () => {
    let requestCalls = 0;
    const base = dependencies(async <T>() => {
      requestCalls += 1;
      return {} as T;
    });

    const authRequired = await uploadLocalGitHubIssueAttachment(
      request(),
      { ...base, resolveOAuthToken: async () => null }
    );
    const notConfigured = await uploadLocalGitHubIssueAttachment(
      request(),
      {
        ...base,
        getGitHubClientId: () => '',
        resolveOAuthToken: async () => null
      }
    );

    expect(authRequired.status).toBe('auth-required');
    expect(notConfigured.status).toBe('not-configured');
    expect(requestCalls).toBe(0);
  });

  test('rejects unavailable repository writes and a mismatched issue target', async () => {
    for (const setup of [
      { issue: { number: ISSUE_NUMBER }, repository: repositoryResponse(false) },
      {
        issue: { number: ISSUE_NUMBER },
        repository: { ...repositoryResponse(), archived: true }
      },
      { issue: { number: ISSUE_NUMBER + 1 }, repository: repositoryResponse() },
      {
        issue: { number: ISSUE_NUMBER, pull_request: {} },
        repository: repositoryResponse()
      }
    ]) {
      let writeCalls = 0;
      const result = await uploadLocalGitHubIssueAttachment(
        request(),
        dependencies(async <T>(path, _token, init) => {
          if (init?.method) writeCalls += 1;
          return (path === `/repos/${REPOSITORY}`
            ? setup.repository
            : setup.issue) as T;
        })
      );
      expect(result.status).toBe('error');
      expect(writeCalls).toBe(0);
    }
  });

  test('rejects an existing path with different bytes without leaking content', async () => {
    const result = await uploadLocalGitHubIssueAttachment(
      request({ bytes: Buffer.from('secret-private-image') }),
      dependencies(async <T>(path, _token, init) => {
        if (path === `/repos/${REPOSITORY}`) return repositoryResponse() as T;
        if (path === `/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
          return { number: ISSUE_NUMBER } as T;
        }
        if (path.endsWith(`/git/ref/heads/${BRANCH_NAME}`)) {
          return { object: { sha: BRANCH_SHA }, ref: BRANCH_REF } as T;
        }
        if (init?.method === 'PUT') {
          throw new Error('GitHub request failed with 409.');
        }
        return { path: EXPECTED_PATH, sha: 'f'.repeat(40) } as T;
      })
    );

    expect(result.status).toBe('error');
    expect(result.message).toContain('dedicated attachment branch');
    expect(result.message).not.toContain('secret-private-image');
  });

  test('rejects malformed GitHub refs and success data', async () => {
    const malformedRef = await uploadLocalGitHubIssueAttachment(
      request(),
      dependencies(async <T>(path) => {
        if (path === `/repos/${REPOSITORY}`) return repositoryResponse() as T;
        if (path === `/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
          return { number: ISSUE_NUMBER } as T;
        }
        return { object: { sha: '../../../main' }, ref: BRANCH_REF } as T;
      })
    );
    expect(malformedRef.status).toBe('error');

    const malformedWrite = await uploadLocalGitHubIssueAttachment(
      request(),
      dependencies(async <T>(path) => {
        if (path === `/repos/${REPOSITORY}`) return repositoryResponse() as T;
        if (path === `/repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`) {
          return { number: ISSUE_NUMBER } as T;
        }
        if (path.endsWith(`/git/ref/heads/${BRANCH_NAME}`)) {
          return { object: { sha: BRANCH_SHA }, ref: BRANCH_REF } as T;
        }
        return {
          commit: { sha: '../../../main' },
          content: { path: EXPECTED_PATH, sha: blobSha(IMAGE_BYTES) }
        } as T;
      })
    );
    expect(malformedWrite).toMatchObject({
      message: 'GitHub returned invalid issue image data.',
      status: 'error'
    });
  });
});
