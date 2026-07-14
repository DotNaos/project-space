import { describe, expect, test } from 'bun:test';

import {
  githubIssueAttachmentContentUrl,
  loadGitHubIssueAttachmentContent
} from '../src/api/github-issue-attachment-content-client';
import {
  parseGitHubIssueAttachmentContentSearch,
  parseProjectSpaceGitHubIssueAttachmentUrl
} from '../src/shared/github-issue-attachment-location';

const REPOSITORY = 'DotNaos/project-space';
const COMMIT_SHA = 'a'.repeat(40);
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000001';
const MARKDOWN_URL =
  `https://github.com/${REPOSITORY}/blob/${COMMIT_SHA}/`
  + `.github/project-space/issue-attachments/${ATTACHMENT_ID}.png?raw=1`;

describe('GitHub issue attachment content client', () => {
  test('proxies only an immutable Project Space image from the current repository', () => {
    const result = githubIssueAttachmentContentUrl(MARKDOWN_URL, REPOSITORY);

    expect(result).toBe(
      '/api/github/issue-attachment-content?'
      + `attachmentId=${ATTACHMENT_ID}`
      + `&commitSha=${COMMIT_SHA}`
      + '&extension=png'
      + '&fullName=DotNaos%2Fproject-space'
    );
    expect(
      parseGitHubIssueAttachmentContentSearch(
        new URL(result!, 'https://projects.example').searchParams
      )
    ).toEqual({
      attachmentId: ATTACHMENT_ID,
      commitSha: COMMIT_SHA,
      extension: 'png',
      fullName: REPOSITORY
    });
  });

  test('rejects another repository, a mutable ref, or a non-generated path', () => {
    const invalidUrls = [
      MARKDOWN_URL.replace('/DotNaos/project-space/', '/DotNaos/private-repository/'),
      MARKDOWN_URL.replace(COMMIT_SHA, 'main'),
      MARKDOWN_URL.replace('/.github/project-space/', '/docs/'),
      MARKDOWN_URL.replace('/issue-attachments/', '/issue-attachments/nested/'),
      MARKDOWN_URL.replace(`${ATTACHMENT_ID}.png`, 'diagram.png')
    ];

    for (const value of invalidUrls) {
      expect(parseProjectSpaceGitHubIssueAttachmentUrl(value, REPOSITORY)).toBeNull();
      expect(githubIssueAttachmentContentUrl(value, REPOSITORY)).toBeUndefined();
    }
  });

  test('rejects relaxed URL, commit, identifier, and extension variants', () => {
    const invalidUrls = [
      MARKDOWN_URL.replace('?raw=1', ''),
      MARKDOWN_URL.replace('?raw=1', '?raw=1&download=1'),
      MARKDOWN_URL.replace('?raw=1', '?raw=true'),
      MARKDOWN_URL.replace(COMMIT_SHA, COMMIT_SHA.toUpperCase()),
      MARKDOWN_URL.replace(ATTACHMENT_ID, '00000000-0000-5000-8000-000000000001'),
      MARKDOWN_URL.replace('.png?raw=1', '.svg?raw=1'),
      MARKDOWN_URL.replace('https://github.com/', 'http://github.com/'),
      MARKDOWN_URL.replace('github.com/', 'user:password@github.com/')
    ];

    for (const value of invalidUrls) {
      expect(githubIssueAttachmentContentUrl(value, REPOSITORY)).toBeUndefined();
    }
  });

  test('rejects missing, duplicate, and unexpected proxy query fields', () => {
    const valid = new URL(githubIssueAttachmentContentUrl(MARKDOWN_URL, REPOSITORY)!, 'https://x');
    for (const search of [
      valid.search.replace(`&commitSha=${COMMIT_SHA}`, ''),
      `${valid.search}&commitSha=${COMMIT_SHA}`,
      `${valid.search}&url=https%3A%2F%2Fattacker.example%2Fimage.png`,
      valid.search.replace(`commitSha=${COMMIT_SHA}`, 'commitSha=main'),
      valid.search.replace('fullName=DotNaos%2Fproject-space', 'fullName=..%2Fsecret')
    ]) {
      expect(parseGitHubIssueAttachmentContentSearch(new URLSearchParams(search))).toBeNull();
    }
  });

  test('loads private bytes with a bearer header without putting the token in the URL', async () => {
    const image = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      'base64'
    );
    const gifUrl = MARKDOWN_URL.replace('.png?raw=1', '.gif?raw=1');
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const result = await loadGitHubIssueAttachmentContent(gifUrl, REPOSITORY, {
      currentHref: 'https://projects.example/issues',
      async fetchImplementation(input, init) {
        requestUrl = String(input);
        requestInit = init;
        return new Response(image, {
          headers: {
            'Content-Length': String(image.byteLength),
            'Content-Type': 'image/gif'
          }
        });
      },
      getAuthToken: async () => 'clerk-browser-token'
    });

    expect(requestUrl).toStartWith(
      'https://projects.example/api/github/issue-attachment-content?'
    );
    expect(requestUrl).not.toContain('clerk-browser-token');
    expect(requestInit?.headers).toEqual({
      Accept: 'image/gif',
      Authorization: 'Bearer clerk-browser-token'
    });
    expect(requestInit?.redirect).toBe('error');
    expect(requestInit?.cache).toBe('no-store');
    expect(result.type).toBe('image/gif');
    expect(Buffer.from(await result.arrayBuffer())).toEqual(image);
  });

  test('uses generic failures without leaking a server response body', async () => {
    const promise = loadGitHubIssueAttachmentContent(MARKDOWN_URL, REPOSITORY, {
      currentHref: 'https://projects.example/issues',
      async fetchImplementation() {
        return new Response('private-path clerk-browser-token', { status: 403 });
      },
      getAuthToken: async () => 'clerk-browser-token'
    });

    await expect(promise).rejects.toThrow('Could not load this issue image.');
    await promise.catch((error) => {
      expect(String(error)).not.toContain('private-path');
      expect(String(error)).not.toContain('clerk-browser-token');
    });
  });

  test('rejects mismatched media types and oversized browser responses', async () => {
    const baseOptions = {
      currentHref: 'https://projects.example/issues',
      getAuthToken: async () => 'token'
    };
    await expect(
      loadGitHubIssueAttachmentContent(MARKDOWN_URL, REPOSITORY, {
        ...baseOptions,
        async fetchImplementation() {
          return new Response('not an image', {
            headers: { 'Content-Type': 'image/jpeg' }
          });
        }
      })
    ).rejects.toThrow('Project Space returned an invalid issue image.');
    await expect(
      loadGitHubIssueAttachmentContent(MARKDOWN_URL, REPOSITORY, {
        ...baseOptions,
        async fetchImplementation() {
          return new Response('tiny', {
            headers: {
              'Content-Length': String(10 * 1024 * 1024 + 1),
              'Content-Type': 'image/png'
            }
          });
        }
      })
    ).rejects.toThrow('Project Space returned an invalid issue image.');
    await expect(
      loadGitHubIssueAttachmentContent(MARKDOWN_URL, REPOSITORY, {
        ...baseOptions,
        async fetchImplementation() {
          return new Response('tiny', {
            headers: {
              'Content-Length': '3',
              'Content-Type': 'image/png'
            }
          });
        }
      })
    ).rejects.toThrow('Project Space returned an invalid issue image.');
    await expect(
      loadGitHubIssueAttachmentContent(MARKDOWN_URL, REPOSITORY, {
        ...baseOptions,
        async fetchImplementation() {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(10 * 1024 * 1024));
                controller.enqueue(new Uint8Array([1]));
                controller.close();
              }
            }),
            { headers: { 'Content-Type': 'image/png' } }
          );
        }
      })
    ).rejects.toThrow('Project Space returned an invalid issue image.');
  });
});
