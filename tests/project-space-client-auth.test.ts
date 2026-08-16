import { afterEach, expect, test } from 'bun:test';

import {
  refreshProjectSpaceAuthToken,
  setProjectSpaceAuthTokenProvider
} from '../src/api/project-space-client-auth';

afterEach(() => {
  setProjectSpaceAuthTokenProvider(null);
});

test('refreshes the provider token when a caller explicitly skips the cache', async () => {
  const calls: Array<{ skipCache?: boolean } | undefined> = [];
  let sequence = 0;
  setProjectSpaceAuthTokenProvider(async (options) => {
    calls.push(options);
    sequence += 1;
    return `token-${sequence}`;
  });

  expect(await refreshProjectSpaceAuthToken()).toBe('token-1');
  expect(await refreshProjectSpaceAuthToken()).toBe('token-2');
  expect(await refreshProjectSpaceAuthToken({ skipCache: true })).toBe('token-3');
  expect(calls).toEqual([{}, {}, { skipCache: true }]);
});
