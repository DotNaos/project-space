import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  uploadLocalGitHubIssueAttachment,
  type LocalGitHubIssueAttachmentDependencies
} from '../server/local-github-issue-attachments';

const REPOSITORY = 'DotNaos/project-space';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000001';
const IMAGE_BYTES = Buffer.from('validated-image-bytes');

function blobSha(bytes: Uint8Array) {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
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

describe('local GitHub issue attachments', () => {
  test('commits a validated image to a server-chosen path and returns an immutable GitHub URL', async () => {
    const calls: Array<{ init?: RequestInit; path: string; token: string }> = [];
    const expectedPath =
      `.github/project-space/issue-attachments/${ATTACHMENT_ID}.png`;
    const result = await uploadLocalGitHubIssueAttachment(
      {
        attachmentId: ATTACHMENT_ID,
        bytes: IMAGE_BYTES,
        declaredMediaType: 'image/png',
        fullName: REPOSITORY
      },
      dependencies(async <T>(path: string, token: string, init?: RequestInit) => {
        calls.push({ init, path, token });
        return {
          commit: { sha: 'a'.repeat(40) },
          content: { path: expectedPath, sha: blobSha(IMAGE_BYTES) }
        } as T;
      })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(
      `/repos/DotNaos/project-space/contents/${expectedPath}`
    );
    expect(calls[0]?.token).toBe('server-only-token');
    expect(calls[0]?.init?.method).toBe('PUT');
    const payload = JSON.parse(String(calls[0]?.init?.body));
    expect(payload).toEqual({
      content: IMAGE_BYTES.toString('base64'),
      message: 'Add Project Space issue image'
    });
    expect(result).toEqual({
      attachmentId: ATTACHMENT_ID,
      fullName: REPOSITORY,
      markdownUrl:
        `https://github.com/DotNaos/project-space/blob/${'a'.repeat(40)}/${expectedPath}?raw=1`,
      mediaType: 'image/png',
      sizeBytes: IMAGE_BYTES.byteLength,
      status: 'connected'
    });
  });

  test('validates repository and attachment scope before resolving credentials', async () => {
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

    for (const request of [
      { attachmentId: ATTACHMENT_ID, fullName: '../secret' },
      { attachmentId: '../../branch', fullName: REPOSITORY },
      { attachmentId: '00000000-0000-4000-8000-00000000000A', fullName: REPOSITORY }
    ]) {
      const result = await uploadLocalGitHubIssueAttachment(
        {
          ...request,
          bytes: IMAGE_BYTES,
          declaredMediaType: 'image/png'
        },
        deps
      );
      expect(result.status).toBe('error');
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
      {
        attachmentId: ATTACHMENT_ID,
        bytes: IMAGE_BYTES,
        declaredMediaType: 'image/png',
        fullName: REPOSITORY
      },
      { ...base, resolveOAuthToken: async () => null }
    );
    expect(authRequired.status).toBe('auth-required');

    const notConfigured = await uploadLocalGitHubIssueAttachment(
      {
        attachmentId: ATTACHMENT_ID,
        bytes: IMAGE_BYTES,
        declaredMediaType: 'image/png',
        fullName: REPOSITORY
      },
      {
        ...base,
        getGitHubClientId: () => '',
        resolveOAuthToken: async () => null
      }
    );
    expect(notConfigured.status).toBe('not-configured');
    expect(requestCalls).toBe(0);
  });

  test('recovers an idempotent retry when the same image already exists', async () => {
    const expectedPath =
      `.github/project-space/issue-attachments/${ATTACHMENT_ID}.png`;
    const calls: string[] = [];
    const result = await uploadLocalGitHubIssueAttachment(
      {
        attachmentId: ATTACHMENT_ID,
        bytes: IMAGE_BYTES,
        declaredMediaType: 'image/png',
        fullName: REPOSITORY
      },
      dependencies(async <T>(path, _token, init) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        if (init?.method === 'PUT') {
          throw new Error('GitHub request failed with 422.');
        }

        if (path.includes('/commits?')) {
          return [{ sha: 'b'.repeat(40) }] as T;
        }

        return {
          path: expectedPath,
          sha: blobSha(IMAGE_BYTES)
        } as T;
      })
    );

    expect(calls).toEqual([
      `PUT /repos/${REPOSITORY}/contents/${expectedPath}`,
      `GET /repos/${REPOSITORY}/commits?path=${encodeURIComponent(expectedPath)}&per_page=1`,
      `GET /repos/${REPOSITORY}/contents/${expectedPath}?ref=${'b'.repeat(40)}`
    ]);
    expect(result).toMatchObject({
      markdownUrl: `https://github.com/${REPOSITORY}/blob/${'b'.repeat(40)}/${expectedPath}?raw=1`,
      status: 'connected'
    });
  });

  test('rejects an existing path with different bytes and never leaks rejected content', async () => {
    const expectedPath =
      `.github/project-space/issue-attachments/${ATTACHMENT_ID}.png`;
    const result = await uploadLocalGitHubIssueAttachment(
      {
        attachmentId: ATTACHMENT_ID,
        bytes: Buffer.from('secret-private-image'),
        declaredMediaType: 'image/png',
        fullName: REPOSITORY
      },
      dependencies(async <T>(_path, _token, init) => {
        if (init?.method === 'PUT') {
          throw new Error('GitHub request failed with 422.');
        }

        if (_path.includes('/commits?')) {
          return [{ sha: 'b'.repeat(40) }] as T;
        }
        return {
          path: expectedPath,
          sha: 'f'.repeat(40)
        } as T;
      })
    );

    expect(result.status).toBe('error');
    expect(result.message).toBe(
      'GitHub could not store this issue image. Check repository write access and branch rules, then retry.'
    );
    expect(result.message).not.toContain('secret-private-image');
  });

  test('rejects retry recovery without an immutable commit', async () => {
    const result = await uploadLocalGitHubIssueAttachment(
      {
        attachmentId: ATTACHMENT_ID,
        bytes: IMAGE_BYTES,
        declaredMediaType: 'image/png',
        fullName: REPOSITORY
      },
      dependencies(async <T>(_path, _token, init) => {
        if (init?.method === 'PUT') {
          throw new Error('GitHub request failed with 409.');
        }
        return [{ sha: 'main' }] as T;
      })
    );

    expect(result).toMatchObject({
      message:
        'GitHub could not store this issue image. Check repository write access and branch rules, then retry.',
      status: 'error'
    });
    expect(result).not.toHaveProperty('markdownUrl');
  });

  test('rejects malformed GitHub success data instead of creating a browser URL', async () => {
    const result = await uploadLocalGitHubIssueAttachment(
      {
        attachmentId: ATTACHMENT_ID,
        bytes: IMAGE_BYTES,
        declaredMediaType: 'image/png',
        fullName: REPOSITORY
      },
      dependencies(async <T>() => ({
        commit: { sha: '../../../main' },
        content: {
          path: `.github/project-space/issue-attachments/${ATTACHMENT_ID}.png`,
          sha: blobSha(IMAGE_BYTES)
        }
      }) as T)
    );

    expect(result).toMatchObject({
      message: 'GitHub returned invalid issue image data.',
      status: 'error'
    });
    expect(result).not.toHaveProperty('markdownUrl');
  });
});
