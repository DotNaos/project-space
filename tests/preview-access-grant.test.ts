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
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
