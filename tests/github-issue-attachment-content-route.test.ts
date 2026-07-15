import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createGitHubIssueAttachmentContentRoute } from '../server/github-issue-attachment-content-route';

const BASE_URL =
  'http://project.test/api/github/issue-attachment-content?'
  + 'attachmentId=00000000-0000-4000-8000-000000000001'
  + `&commitSha=${'a'.repeat(40)}`
  + '&extension=png'
  + '&fullName=DotNaos%2Fproject-space'
  + '&issueNumber=187';

function request(method: string) {
  return { method } as IncomingMessage;
}

function responseRecorder() {
  let body = Buffer.alloc(0);
  let status = 0;
  const headers = new Map<string, string>();
  const response = {
    end(value?: string | Uint8Array) {
      body = value === undefined ? Buffer.alloc(0) : Buffer.from(value);
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

  return { read: () => ({ body, headers, status }), response };
}

describe('GitHub issue attachment content route', () => {
  test('returns validated bytes with private, non-sniffable image headers', async () => {
    const image = Buffer.from([1, 2, 3, 4]);
    let loadedLocation: unknown;
    const route = createGitHubIssueAttachmentContentRoute({
      async loadAttachment(location) {
        loadedLocation = location;
        return {
          bytes: image,
          mediaType: 'image/png',
          sizeBytes: image.byteLength,
          status: 'connected'
        };
      }
    });
    const output = responseRecorder();

    expect(await route(request('GET'), output.response, new URL(BASE_URL))).toBe(true);
    expect(loadedLocation).toEqual({
      attachmentId: '00000000-0000-4000-8000-000000000001',
      commitSha: 'a'.repeat(40),
      extension: 'png',
      fullName: 'DotNaos/project-space',
      issueNumber: 187
    });
    const result = output.read();
    expect(result.status).toBe(200);
    expect(result.body).toEqual(image);
    expect(result.headers.get('content-type')).toBe('image/png');
    expect(result.headers.get('content-length')).toBe('4');
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(result.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox"
    );
  });

  test('rejects loose or duplicate request scope without loading GitHub content', async () => {
    let calls = 0;
    const route = createGitHubIssueAttachmentContentRoute({
      async loadAttachment() {
        calls += 1;
        return { message: 'unused', status: 'error' };
      }
    });

    for (const value of [
      BASE_URL.replace(`&commitSha=${'a'.repeat(40)}`, ''),
      `${BASE_URL}&commitSha=${'a'.repeat(40)}`,
      BASE_URL.replace(`commitSha=${'a'.repeat(40)}`, 'commitSha=main'),
      `${BASE_URL}&source=https%3A%2F%2Fattacker.example%2Fprivate.png`
    ]) {
      const output = responseRecorder();
      expect(await route(request('GET'), output.response, new URL(value))).toBe(true);
      expect(output.read().status).toBe(400);
      expect(JSON.parse(output.read().body.toString())).toEqual({
        error: 'Invalid issue image request.'
      });
    }
    expect(calls).toBe(0);
  });

  test('maps safe connection failures without exposing binary content', async () => {
    const cases = [
      { expectedStatus: 401, status: 'auth-required' as const },
      { expectedStatus: 503, status: 'not-configured' as const },
      { expectedStatus: 404, status: 'error' as const }
    ];

    for (const item of cases) {
      const route = createGitHubIssueAttachmentContentRoute({
        async loadAttachment() {
          return { message: 'Safe issue image error.', status: item.status };
        }
      });
      const output = responseRecorder();
      expect(await route(request('GET'), output.response, new URL(BASE_URL))).toBe(true);
      expect(output.read().status).toBe(item.expectedStatus);
      expect(JSON.parse(output.read().body.toString())).toEqual({
        error: 'Safe issue image error.'
      });
      expect(output.read().headers.get('cache-control')).toBe('private, no-store');
      expect(output.read().headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  test('leaves unrelated paths and methods to the remaining API router', async () => {
    const route = createGitHubIssueAttachmentContentRoute();
    for (const [method, url] of [
      ['POST', BASE_URL],
      ['GET', 'http://project.test/api/github/issue-attachments']
    ]) {
      const output = responseRecorder();
      expect(await route(request(method), output.response, new URL(url))).toBe(false);
      expect(output.read().status).toBe(0);
    }
  });
});
