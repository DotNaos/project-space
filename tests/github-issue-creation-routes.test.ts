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

function hangingRequest(headers: IncomingMessage['headers']) {
  let sentChunk = false;
  const value = new Readable({
    read() {
      if (sentChunk) return;
      sentChunk = true;
      this.push(Buffer.from([1]));
    }
  }) as IncomingMessage;
  value.method = 'POST';
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
        return {
          attachmentStorage: 'per-issue-branch',
          attachmentWrite: 'unverified',
          fullName,
          labels: [{ color: '123abc', name: 'bug' }],
          labelWrite: 'unverified',
          status: 'connected'
        };
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
          issueNumber: value.issueNumber,
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
        'http://project.test/api/github/issue-attachments?fullName=DotNaos%2Fproject-space&attachmentId=00000000-0000-4000-8000-000000000001&issueNumber=187'
      )
    );

    expect(handled).toBe(true);
    expect(uploadRequest).toEqual({
      attachmentId: '00000000-0000-4000-8000-000000000001',
      bytes: image,
      declaredMediaType: 'image/png',
      fullName: 'DotNaos/project-space',
      issueNumber: 187
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
        return { attachmentId: '', fullName: '', issueNumber: 1, status: 'error' };
      }
    });
    const cases = [
      {
        expected: 415,
        headers: { 'content-type': 'image/svg+xml' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001&issueNumber=1',
        chunks: [Buffer.from('<svg/>')]
      },
      {
        expected: 400,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&fullName=c%2Fd&attachmentId=00000000-0000-4000-8000-000000000001&issueNumber=1',
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
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-00000000000A&issueNumber=1',
        chunks: [Buffer.from([1])]
      },
      {
        expected: 400,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001&issueNumber=1',
        chunks: []
      },
      {
        expected: 413,
        headers: { 'content-length': '5', 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001&issueNumber=1',
        chunks: [Buffer.alloc(5)]
      },
      {
        expected: 413,
        headers: { 'content-type': 'image/png' },
        url: 'http://project.test/api/github/issue-attachments?fullName=a%2Fb&attachmentId=00000000-0000-4000-8000-000000000001&issueNumber=1',
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

  test('bounds active and waiting uploads before reading more request bodies', async () => {
    let releaseFirst = () => {};
    let firstStarted = () => {};
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstReleasePromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let uploadCount = 0;
    const route = createGitHubIssueCreationRoutes({
      maximumConcurrentUploads: 1,
      maximumWaitingUploads: 1,
      async uploadAttachment(value) {
        uploadCount += 1;
        if (uploadCount === 1) {
          firstStarted();
          await firstReleasePromise;
        }
        return {
          attachmentId: value.attachmentId,
          fullName: value.fullName,
          issueNumber: value.issueNumber,
          markdownUrl:
            `https://github.com/DotNaos/project-space/blob/${'a'.repeat(40)}/image.png?raw=1`,
          mediaType: 'image/png',
          sizeBytes: value.bytes.byteLength,
          status: 'connected'
        };
      }
    });
    const url = (id: number) => new URL(
      'http://project.test/api/github/issue-attachments'
      + `?fullName=DotNaos%2Fproject-space&attachmentId=00000000-0000-4000-8000-${String(id).padStart(12, '0')}&issueNumber=187`
    );
    const run = (id: number) => {
      const output = responseRecorder();
      const handled = route(
        request('POST', [Buffer.from([id])], {
          'content-length': '1',
          'content-type': 'image/png'
        }),
        output.response,
        url(id)
      );
      return { handled, output };
    };

    const first = run(1);
    await firstStartedPromise;
    const second = run(2);
    await Promise.resolve();
    const third = run(3);
    expect(await third.handled).toBe(true);
    expect(third.output.read()).toMatchObject({
      body: { error: 'Too many issue images are waiting to upload.' },
      status: 429
    });
    expect(third.output.read().headers.get('retry-after')).toBe('1');

    releaseFirst();
    await Promise.all([first.handled, second.handled]);
    expect(first.output.read().status).toBe(200);
    expect(second.output.read().status).toBe(200);
    expect(uploadCount).toBe(2);
  });

  test('stops a stalled image body at the configured read deadline', async () => {
    let uploadCount = 0;
    const route = createGitHubIssueCreationRoutes({
      bodyReadTimeoutMs: 5,
      async uploadAttachment() {
        uploadCount += 1;
        return { attachmentId: '', fullName: '', issueNumber: 1, status: 'error' };
      }
    });
    const stalledRequest = hangingRequest({ 'content-type': 'image/png' });
    const output = responseRecorder();

    expect(await route(
      stalledRequest,
      output.response,
      new URL(
        'http://project.test/api/github/issue-attachments?fullName=DotNaos%2Fproject-space&attachmentId=00000000-0000-4000-8000-000000000001&issueNumber=187'
      )
    )).toBe(true);
    expect(output.read()).toMatchObject({
      body: { error: 'The issue image upload timed out.' },
      status: 408
    });
    expect(stalledRequest.destroyed).toBe(true);
    expect(uploadCount).toBe(0);
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
