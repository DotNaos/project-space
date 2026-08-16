import { describe, expect, test } from 'bun:test';

import { HttpProjectSpaceClient } from '../src/api/project-space-client';

class RecordingClient extends HttpProjectSpaceClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  protected override request<Result>(path: string, init?: RequestInit): Promise<Result> {
    this.calls.push({ init, path });
    return Promise.resolve({
      apiVersion: 1,
      checkedAt: '2026-08-16T09:00:00.000Z',
      codespaces: [],
      provider: { connectionState: 'connected', source: 'github_api' }
    } as Result);
  }
}

describe('GitHub Codespace inventory client', () => {
  test('reads the dedicated provider inventory route', async () => {
    const client = new RecordingClient();

    await expect(client.getGitHubCodespaceInventory()).resolves.toMatchObject({
      provider: { connectionState: 'connected', source: 'github_api' }
    });
    expect(client.calls).toEqual([{
      init: undefined,
      path: '/api/compute/github/codespaces'
    }]);
  });
});
