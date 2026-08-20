import { describe, expect, test } from 'bun:test';
import { HttpProjectSpaceClient } from '../src/api/project-space-client';

class RegressionClient extends HttpProjectSpaceClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  protected override request<Result>(path: string, init?: RequestInit): Promise<Result> {
    this.calls.push({ init, path });
    return Promise.resolve({} as Result);
  }
}

describe('source-first compute inventory client regression', () => {
  test('loads the two authoritative providers without the retired Connector overview', async () => {
    const client = new RegressionClient();

    await Promise.all([
      client.getTailscaleInventory(true),
      client.getGitHubCodespaceInventory()
    ]);

    expect(client.calls).toEqual([
      { init: undefined, path: '/api/compute/tailscale/devices?refresh=1' },
      { init: undefined, path: '/api/compute/github/codespaces' }
    ]);
    expect(client.calls.some(({ path }) => path.includes('/api/connectors/overview'))).toBe(false);
    expect(client.calls.some(({ path }) => path.includes('/api/compute/inventory'))).toBe(false);
    expect(client.calls.some(({ path }) => path.includes('/api/compute/legacy-connectors'))).toBe(false);
  });

  test('sends inline classification with the observed revision', async () => {
    const client = new RegressionClient();

    await client.setTailscaleDeviceClassification('device-12', {
      classification: 'environment',
      expectedRevision: 4
    });

    expect(client.calls).toEqual([{
      init: {
        body: JSON.stringify({ classification: 'environment', expectedRevision: 4 }),
        method: 'POST'
      },
      path: '/api/compute/tailscale/devices/device-12/classification'
    }]);
  });
});
