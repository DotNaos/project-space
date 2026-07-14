import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { createGitHubIssueCreationRoutes } from '../server/github-issue-creation-routes';

function request(
  method: string,
  chunks: Uint8Array[] = [],
  headers: IncomingMessage['headers'] = {}
) {
  const value = Readable.from(chunks) as IncomingMessage;
  value.method = method;
  value.headers = headers;
  return value;
}

function responseRecorder() {
  let body = '';
  let status = 0;
  const headers = new Map<string, string>();
  const response = {
    end(value?: string) {
      body = value ?? '';
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    writeHead(code: number, values?: Record<string, string>) {
      status = code;
      for (const [name, value] of Object.entries(values ?? {})) {
        headers.set(name.toLowerCase(), value);
      }
      return response;
    }
  } as unknown as ServerResponse;

  return {
    read() {
      return { body: body ? JSON.parse(body) : undefined, headers, status };
    },
    response
  };
}

describe('GitHub issue creation routes', () => {
  test('loads private repository label metadata through the focused server module', async () => {
    const output = responseRecorder();
    let requestedRepository = '';
    const route = createGitHubIssueCreationRoutes({
      async loadMetadata(fullName) {
        requestedRepository = fullName;
        return { fullName, labels: [{ color: '123abc', name: 'bug' }], status: 'connected' };
      }
    });
    const handled = await route(
      request('GET'),
      output.response,
      new URL('http://project.test/api/github/issue-metadata?fullName=DotNaos%2Fproject-space')
    );

    const result = output.read();
    expect(handled).toBe(true);
    expect(requestedRepository).toBe('DotNaos/project-space');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.body.status).toBe('connected');
  });

  test('passes bounded image bytes and server-owned request fields to the uploader', async () => {
    const output = responseRecorder();
    const image = Buffer.from([1, 2, 3, 4]);
    let uploadRequest: unknown;
    const route = createGitHubIssueCreationRoutes({
      async uploadAttachment(value) {
        uploadRequest = value;
        return {
          attachmentId: value.attachmentId,
          fullName: value.fullName,
          markdownUrl:
            `https://github.com/DotNaos/project-space/blob/${'a'.repeat(40)}/image.png?raw=1`,
          mediaType: 'image/png',
          sizeBytes: value.bytes.byteLength,
          status: 'connected'
        };
      }
    });
    const handled = await route(
      request('POST', [image], {
        'content-length': String(image.byteLength),
        'content-type': 'image/png'
      }),
      output.response,
      new URL(
        'http://project.test/api/github/issue-attachments?fullName=DotNaos%2Fproject-space&attachmentId=00000000-0000-4000-8000-000000000001'
      )
    );

    expect(handled).toBe(true);
    expect(uploadRequest).toEqual({
      attachmentId: '00000000-0000-4000-8000-000000000001',
      bytes: image,
      declaredMediaType: 'image/png',
      fullName: 'DotNaos/project-space'
    });
    expect(output.read().status).toBe(200);
    expect(output.read().headers.get('cache-control')).toBe('private, no-store');
  });

  test('rejects unsupported types, missing scope, empty bodies, and oversized bodies', async () => {
    const calls: unknown[] = [];
    const route = createGitHubIssueCreationRoutes({
      maximumBodyBytes: 4,
      async uploadAttachment(value) {
        calls.push(value);
        return { attachmentId: '', fullName: '', status: 'error' };
      }
    });
    const cases = [
      {
        expected: 415,
        headers: { 'content-type': 'image/svg+xml' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001',
        chunks: [Buffer.from('<svg/>')]
      },
      {
        expected: 400,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&fullName=c%2Fd&attachmentId=00000000-0000-4000-8000-000000000001',
        chunks: [Buffer.from([1])]
      },
      {
        expected: 400,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments',
        chunks: [Buffer.from([1])]
      },
      {
        expected: 400,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-00000000000A',
        chunks: [Buffer.from([1])]
      },
      {
        expected: 400,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001',
        chunks: []
      },
      {
        expected: 413,
        headers: { 'content-length': '5', 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001',
        chunks: [Buffer.alloc(5)]
      },
      {
        expected: 413,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001',
        chunks: [Buffer.alloc(3), Buffer.alloc(2)]
      }
    ];

    for (const item of cases) {
      const output = responseRecorder();
      expect(
        await route(
          request('POST', item.chunks, item.headers),
          output.response,
          new URL(item.url)
        )
      ).toBe(true);
      expect(output.read().status).toBe(item.expected);
    }
    expect(calls).toHaveLength(0);
  });

  test('leaves unrelated paths for the remaining API router', async () => {
    const output = responseRecorder();
    const route = createGitHubIssueCreationRoutes();
    expect(
      await route(
        request('GET'),
        output.response,
        new URL('http://project.test/api/github/issues')
      )
    ).toBe(false);
    expect(output.read().status).toBe(0);
  });
});
