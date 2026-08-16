import { afterEach, expect, test } from 'bun:test';

import { ProjectSpaceHttpClient } from '../src/api/project-space-client-http';
import {
  setProjectSpaceAuthTokenProvider
} from '../src/api/project-space-client-auth';
import { establishPrototypeAccess } from '../src/api/prototype-access-client';

class TestProjectSpaceHttpClient extends ProjectSpaceHttpClient {
  grantPreviewAccess(pullRequestNumber: number) {
    return this.establishPreviewAccess(pullRequestNumber);
  }

  requestPreviewHubForTest() {
    return this.requestPreviewHub<{ ok: true }>('/api/pull-request-previews');
  }
}

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  setProjectSpaceAuthTokenProvider(null);
});

test('retries a Preview access grant once with a freshly minted token after a 401', async () => {
  const requests: Array<{ authorization?: string }> = [];
  let tokenNumber = 0;
  setProjectSpaceAuthTokenProvider(async (options) => {
    tokenNumber += 1;
    return options?.skipCache ? `fresh-token-${tokenNumber}` : `cached-token-${tokenNumber}`;
  });
  globalThis.fetch = async (_input, init) => {
    requests.push({ authorization: new Headers(init?.headers).get('Authorization') ?? undefined });
    return new Response(null, { status: requests.length === 1 ? 401 : 204 });
  };

  await new TestProjectSpaceHttpClient().grantPreviewAccess(783);

  expect(requests).toEqual([
    { authorization: 'Bearer cached-token-1' },
    { authorization: 'Bearer fresh-token-2' }
  ]);
});

test('retries a Prototype access grant once with a freshly minted token after a 401', async () => {
  const requests: Array<{ authorization?: string }> = [];
  let tokenNumber = 0;
  setProjectSpaceAuthTokenProvider(async (options) => {
    tokenNumber += 1;
    return options?.skipCache ? `fresh-token-${tokenNumber}` : `cached-token-${tokenNumber}`;
  });
  globalThis.fetch = async (_input, init) => {
    requests.push({ authorization: new Headers(init?.headers).get('Authorization') ?? undefined });
    return new Response(null, { status: requests.length === 1 ? 401 : 204 });
  };

  await establishPrototypeAccess(
    'https://pr-783.projects.os-home.net/prototype/desktop/',
    783,
    'direct-preview',
    'desktop-prototype'
  );

  expect(requests).toEqual([
    { authorization: 'Bearer cached-token-1' },
    { authorization: 'Bearer fresh-token-2' }
  ]);
});

test('retries Preview manager requests once with a freshly minted token after a 401', async () => {
  const requests: Array<{ authorization?: string }> = [];
  let tokenNumber = 0;
  setProjectSpaceAuthTokenProvider(async (options) => {
    tokenNumber += 1;
    return options?.skipCache ? `fresh-token-${tokenNumber}` : `cached-token-${tokenNumber}`;
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { hostname: 'pr.projects.os-home.net' } }
  });
  globalThis.fetch = async (_input, init) => {
    requests.push({ authorization: new Headers(init?.headers).get('Authorization') ?? undefined });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: requests.length === 1 ? 401 : 200
    });
  };

  await expect(new TestProjectSpaceHttpClient().requestPreviewHubForTest()).resolves.toEqual({ ok: true });

  expect(requests).toEqual([
    { authorization: 'Bearer cached-token-1' },
    { authorization: 'Bearer fresh-token-2' }
  ]);
});
