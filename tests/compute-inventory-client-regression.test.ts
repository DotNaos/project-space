import { describe, expect, test } from 'bun:test';
import { HttpProjectSpaceClient } from '../src/api/project-space-client';
import type { ProjectCliComputeInventory } from '../src/shared/compute-inventory-cli-api';
import { computePlatformSections } from '../src/features/project-desktop/components/machines-page-model';

class RegressionClient extends HttpProjectSpaceClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  protected override request<Result>(path: string, init?: RequestInit): Promise<Result> {
    this.calls.push({ init, path });
    if (path === '/api/connectors/overview') {
      return Promise.reject(new Error('410 Gone'));
    }
    return Promise.resolve({
      checkedAt: '2026-08-13T11:33:21.452Z',
      environmentCatalog: [],
      environmentInstances: [{
        accessRoutes: [],
        alias: 'project-space-537-qxpr6qvjp9vf5v',
        environmentDefinitionId: 'definition-codespace',
        hostResolution: 'not_applicable',
        hostd: { state: 'unknown' },
        id: 'environment-codespace',
        kind: 'github_codespace',
        name: 'GitHub Codespace',
        platformId: 'platform-codespaces',
        providerLifecycleState: 'unknown',
        reference: 'platform-codespaces/provider/environment-codespace',
        resourceMode: 'dedicated',
        workspaceInventory: { state: 'unavailable' },
        workspaces: []
      }],
      hosts: [],
      inventoryState: 'ready',
      platforms: [{ alias: 'github-codespaces', id: 'platform-codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }],
      privateNetworks: [],
      schemaVersion: 3,
      violations: []
    } as Result);
  }
}

describe('canonical compute inventory client regression', () => {
  test('keeps Codespaces visible when the retired Connector overview returns 410', async () => {
    const client = new RegressionClient();
    await expect(client.getConnectorOverview()).rejects.toThrow('410 Gone');
    const inventory = await client.getComputeInventory();
    const sections = computePlatformSections(inventory as ProjectCliComputeInventory);

    expect(client.calls.map(({ path }) => path)).toEqual([
      '/api/connectors/overview',
      '/api/compute/inventory'
    ]);
    expect(client.calls[1]!.init?.headers).toEqual({
      Accept: 'application/vnd.project-space.compute-inventory+json; version=3'
    });
    expect(sections[0]!.rows.map((row) => row.name)).toEqual(['project-space-537-qxpr6qvjp9vf5v']);
  });
});
