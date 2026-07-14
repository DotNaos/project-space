import { describe, expect, test } from 'bun:test';

import { GITHUB_ISSUE_MAX_ATTACHMENT_BYTES } from '../server/github-issue-attachment-validation';
import {
  loadLocalGitHubIssueAttachmentContent,
  type LocalGitHubIssueAttachmentContentDependencies
} from '../server/local-github-issue-attachment-content';
import type { GitHubIssueAttachmentLocation } from '../src/shared/github-issue-attachment-location';

const GIF_1X1 = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  'base64'
);
const LOCATION: GitHubIssueAttachmentLocation = {
  attachmentId: '00000000-0000-4000-8000-000000000001',
  commitSha: 'a'.repeat(40),
  extension: 'gif',
  fullName: 'DotNaos/project-space',
  issueNumber: 187
};

function dependencies(
  fetchImplementation: LocalGitHubIssueAttachmentContentDependencies['fetch']
): LocalGitHubIssueAttachmentContentDependencies {
  return {
    fetch: fetchImplementation,
    getGitHubClientId: () => 'github-client',
    async resolveOAuthToken() {
      return { token: 'server-only-token' };
    },
    async validateAttachment(input) {
      const { validateGitHubIssueAttachment } = await import(
        '../server/github-issue-attachment-validation'
      );
      return validateGitHubIssueAttachment(input);
    }
  };
}

function chunkedResponse(chunks: Uint8Array[], headers?: HeadersInit) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }
    }),
    { headers, status: 200 }
  );
}

describe('local GitHub issue attachment content', () => {
  test('fetches the exact generated path at an immutable commit using server OAuth', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const result = await loadLocalGitHubIssueAttachmentContent(
      LOCATION,
      dependencies(async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(GIF_1X1, {
          headers: { 'Content-Type': 'application/octet-stream' },
          status: 200
        });
      })
    );

    expect(requestUrl).toBe(
      'https://api.github.com/repos/DotNaos/project-space/contents/'
      + '.github/project-space/issue-attachments/'
      + `${LOCATION.issueNumber}/${LOCATION.attachmentId}.gif?ref=${LOCATION.commitSha}`
    );
    expect(requestInit?.method).toBe('GET');
    expect(requestInit?.redirect).toBe('error');
    expect(requestInit?.cache).toBe('no-store');
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(requestInit?.headers).toEqual({
      Accept: 'application/vnd.github.raw+json',
      Authorization: 'Bearer server-only-token',
      'X-GitHub-Api-Version': '2022-11-28'
    });
    expect(result).toEqual({
      bytes: GIF_1X1,
      mediaType: 'image/gif',
      sizeBytes: GIF_1X1.byteLength,
      status: 'connected'
    });
  });

  test('rejects an invalid location before resolving credentials or using the network', async () => {
    let authCalls = 0;
    let fetchCalls = 0;
    const deps = dependencies(async () => {
      fetchCalls += 1;
      return new Response(GIF_1X1);
    });
    deps.resolveOAuthToken = async () => {
      authCalls += 1;
      return { token: 'unused' };
    };

    const result = await loadLocalGitHubIssueAttachmentContent(
      { ...LOCATION, commitSha: 'main' } as GitHubIssueAttachmentLocation,
      deps
    );

    expect(result).toEqual({
      message: 'GitHub could not load this issue image.',
      status: 'error'
    });
    expect(authCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test('reports GitHub connection states without making a raw-content request', async () => {
    let fetchCalls = 0;
    const base = dependencies(async () => {
      fetchCalls += 1;
      return new Response(GIF_1X1);
    });

    const authRequired = await loadLocalGitHubIssueAttachmentContent(LOCATION, {
      ...base,
      resolveOAuthToken: async () => null
    });
    const notConfigured = await loadLocalGitHubIssueAttachmentContent(LOCATION, {
      ...base,
      getGitHubClientId: () => '',
      resolveOAuthToken: async () => null
    });

    expect(authRequired.status).toBe('auth-required');
    expect(notConfigured.status).toBe('not-configured');
    expect(fetchCalls).toBe(0);
  });

  test('rejects oversized declared and streamed responses before validation', async () => {
    let validationCalls = 0;
    const declaredTooLarge = dependencies(async () =>
      new Response(GIF_1X1, {
        headers: {
          'Content-Length': String(GITHUB_ISSUE_MAX_ATTACHMENT_BYTES + 1)
        }
      })
    );
    declaredTooLarge.validateAttachment = async () => {
      validationCalls += 1;
      return { extension: 'gif', height: 1, mediaType: 'image/gif', width: 1 };
    };
    const streamedTooLarge = dependencies(async () =>
      chunkedResponse([Buffer.alloc(3), Buffer.alloc(2)])
    );
    streamedTooLarge.maximumBytes = 4;
    streamedTooLarge.validateAttachment = declaredTooLarge.validateAttachment;

    expect(
      (await loadLocalGitHubIssueAttachmentContent(LOCATION, declaredTooLarge)).status
    ).toBe('error');
    expect(
      (await loadLocalGitHubIssueAttachmentContent(LOCATION, streamedTooLarge)).status
    ).toBe('error');
    expect(validationCalls).toBe(0);
  });

  test('rejects spoofed image bytes even when GitHub declares an image content type', async () => {
    const result = await loadLocalGitHubIssueAttachmentContent(
      { ...LOCATION, extension: 'png' },
      dependencies(async () =>
        new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          headers: { 'Content-Type': 'image/png' },
          status: 200
        })
      )
    );

    expect(result).toEqual({
      message: 'GitHub could not load this issue image.',
      status: 'error'
    });
  });

  test('does not expose GitHub response details or tokens on failures', async () => {
    const result = await loadLocalGitHubIssueAttachmentContent(
      LOCATION,
      dependencies(async () =>
        new Response('secret-repository-path server-only-token', { status: 403 })
      )
    );

    expect(result).toEqual({
      message: 'GitHub could not load this issue image.',
      status: 'error'
    });
    expect('message' in result ? result.message : '').not.toContain('server-only-token');
    expect('message' in result ? result.message : '').not.toContain('secret-repository-path');
  });

  test('bounds concurrent private image fetches and validation work', async () => {
    let active = 0;
    let maximumActive = 0;
    const deps = dependencies(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return new Response(GIF_1X1, { status: 200 });
    });

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        loadLocalGitHubIssueAttachmentContent(LOCATION, deps)
      )
    );

    expect(results.every((result) => result.status === 'connected')).toBe(true);
    expect(maximumActive).toBe(2);
  });
});
