import { describe, expect, test } from 'bun:test';

import { uploadGitHubIssueAttachment } from '../src/api/github-issue-attachment-client';

const REPOSITORY = 'DotNaos/project-space';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000001';

describe('GitHub issue attachment browser client', () => {
  test('sends image bytes only to the authenticated Project Space origin', async () => {
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const result = await uploadGitHubIssueAttachment(
      { attachmentId: ATTACHMENT_ID, fullName: REPOSITORY, image },
      {
        apiBaseUrl: 'http://127.0.0.1:45873',
        currentHref: 'http://localhost:5173/projects',
        async fetchImplementation(input, init) {
          requestUrl = input.toString();
          requestInit = init;
          return Response.json({
            attachmentId: ATTACHMENT_ID,
            fullName: REPOSITORY,
            markdownUrl:
              `https://github.com/DotNaos/project-space/blob/${'a'.repeat(40)}/.github/project-space/issue-attachments/${ATTACHMENT_ID}.png?raw=1`,
            mediaType: 'image/png',
            sizeBytes: 3,
            status: 'connected'
          });
        },
        getAuthToken: () => 'project-space-session'
      }
    );

    const parsedRequestUrl = new URL(requestUrl);
    expect(parsedRequestUrl.origin + parsedRequestUrl.pathname).toBe(
      'http://127.0.0.1:45873/api/github/issue-attachments'
    );
    expect(parsedRequestUrl.searchParams.get('fullName')).toBe(REPOSITORY);
    expect(parsedRequestUrl.searchParams.get('attachmentId')).toBe(ATTACHMENT_ID);
    expect(requestInit?.method).toBe('POST');
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe(
      'Bearer project-space-session'
    );
    expect(new Headers(requestInit?.headers).get('Content-Type')).toBe('image/png');
    expect(requestInit?.body).toBe(image);
    expect(result.status).toBe('connected');
  });

  test('rejects response state from another repository or attachment request', async () => {
    for (const responseIdentity of [
      { attachmentId: ATTACHMENT_ID, fullName: 'DotNaos/other' },
      {
        attachmentId: '00000000-0000-4000-8000-000000000002',
        fullName: REPOSITORY
      }
    ]) {
      await expect(
        uploadGitHubIssueAttachment(
          {
            attachmentId: ATTACHMENT_ID,
            fullName: REPOSITORY,
            image: new Blob([new Uint8Array([1])], { type: 'image/png' })
          },
          {
            currentHref: 'https://projects.os-home.net/projects',
            async fetchImplementation() {
              return Response.json({
                ...responseIdentity,
                markdownUrl: 'https://github.com/DotNaos/project-space/blob/main/image.png?raw=1',
                mediaType: 'image/png',
                sizeBytes: 1,
                status: 'connected'
              });
            },
            getAuthToken: () => null
          }
        )
      ).rejects.toThrow('different attachment request');
    }
  });

  test('rejects non-GitHub image URLs and malformed connected responses', async () => {
    await expect(
      uploadGitHubIssueAttachment(
        {
          attachmentId: ATTACHMENT_ID,
          fullName: REPOSITORY,
          image: new Blob([new Uint8Array([1])], { type: 'image/png' })
        },
        {
          currentHref: 'https://projects.os-home.net/projects',
          async fetchImplementation() {
            return Response.json({
              attachmentId: ATTACHMENT_ID,
              fullName: REPOSITORY,
              markdownUrl: 'https://attacker.example/tracker.png',
              mediaType: 'image/png',
              sizeBytes: 1,
              status: 'connected'
            });
          },
          getAuthToken: () => null
        }
      )
    ).rejects.toThrow('invalid GitHub issue image response');
  });

  test('rejects a GitHub URL outside the exact repository attachment location', async () => {
    await expect(
      uploadGitHubIssueAttachment(
        {
          attachmentId: ATTACHMENT_ID,
          fullName: REPOSITORY,
          image: new Blob([new Uint8Array([1])], { type: 'image/png' })
        },
        {
          currentHref: 'https://projects.os-home.net/projects',
          async fetchImplementation() {
            return Response.json({
              attachmentId: ATTACHMENT_ID,
              fullName: REPOSITORY,
              markdownUrl:
                `https://github.com/DotNaos/other/blob/${'a'.repeat(40)}/.github/project-space/issue-attachments/${ATTACHMENT_ID}.png?raw=1`,
              mediaType: 'image/png',
              sizeBytes: 1,
              status: 'connected'
            });
          },
          getAuthToken: () => null
        }
      )
    ).rejects.toThrow('invalid GitHub issue image response');
  });

  test('ignores an attacker-controlled API base before requesting authentication', async () => {
    let requestUrl = '';
    let authCalls = 0;
    await uploadGitHubIssueAttachment(
      {
        attachmentId: ATTACHMENT_ID,
        fullName: REPOSITORY,
        image: new Blob([new Uint8Array([1])], { type: 'image/gif' })
      },
      {
        apiBaseUrl: 'https://attacker.example',
        currentHref: 'http://localhost:5173/projects',
        async fetchImplementation(input) {
          requestUrl = input.toString();
          return Response.json({
            attachmentId: ATTACHMENT_ID,
            fullName: REPOSITORY,
            markdownUrl:
              `https://github.com/DotNaos/project-space/blob/${'a'.repeat(40)}/.github/project-space/issue-attachments/${ATTACHMENT_ID}.gif?raw=1`,
            mediaType: 'image/gif',
            sizeBytes: 1,
            status: 'connected'
          });
        },
        getAuthToken() {
          authCalls += 1;
          return 'project-space-session';
        }
      }
    );

    expect(requestUrl).toStartWith('http://localhost:5173/api/github/issue-attachments?');
    expect(authCalls).toBe(1);
  });

  test('rejects unsupported or oversized input before fetch', async () => {
    let fetchCalls = 0;
    const options = {
      currentHref: 'https://projects.os-home.net/projects',
      async fetchImplementation() {
        fetchCalls += 1;
        return Response.json({});
      },
      getAuthToken: () => null
    };

    await expect(
      uploadGitHubIssueAttachment(
        {
          attachmentId: ATTACHMENT_ID,
          fullName: REPOSITORY,
          image: new Blob(['<svg/>'], { type: 'image/svg+xml' })
        },
        options
      )
    ).rejects.toThrow('PNG, JPEG, or GIF');

    await expect(
      uploadGitHubIssueAttachment(
        {
          attachmentId: ATTACHMENT_ID,
          fullName: REPOSITORY,
          image: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], {
            type: 'image/png'
          })
        },
        options
      )
    ).rejects.toThrow('10 MiB or smaller');
    await expect(
      uploadGitHubIssueAttachment(
        {
          attachmentId: '00000000-0000-4000-8000-00000000000A',
          fullName: REPOSITORY,
          image: new Blob([new Uint8Array([1])], { type: 'image/png' })
        },
        options
      )
    ).rejects.toThrow('request is invalid');
    expect(fetchCalls).toBe(0);
  });
});
