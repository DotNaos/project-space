import { describe, expect, test } from 'bun:test';

import {
  listRepositoryIssues,
  type requestGitHub
} from '../server/local-github-catalog';

describe('GitHub repository issue listing', () => {
  test('keeps the general repository view to one bounded GitHub page', async () => {
    const calls: string[] = [];
    const request = (async <Result>(path: string) => {
      calls.push(path);
      return [] as Result;
    }) as typeof requestGitHub;

    await listRepositoryIssues('DotNaos/project-space', 'read-token', request);

    expect(calls).toEqual([
      '/repos/DotNaos/project-space/issues?state=all&per_page=100&sort=updated&direction=desc'
    ]);
  });
});
