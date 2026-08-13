import { describe, expect, test } from 'bun:test';

import { loadConfiguredComputeInventory } from '../server/configured-compute-inventory';
import type { ConnectorOverviewResult, MachineRecord } from '../src/shared/project-space-api';

function connector(): MachineRecord {
  return {
    compute: {
      environmentIdentity: { key: 'environment:canonical-machine', version: 1 },
      environmentKind: 'native_linux',
      environmentName: 'Canonical Linux',
      hostEvidence: 'none',
      hostResolution: 'unresolved',
      platformKind: 'local',
      platformName: 'Local & self-hosted',
      resourceMode: 'dedicated'
    },
    connector: { status: 'local' },
    id: 'canonical-machine',
    kind: 'local',
    name: 'Canonical machine',
    network: {},
    roles: ['connector'],
    sourcePath: ''
  };
}

function overview(machine: MachineRecord): ConnectorOverviewResult {
  return {
    connectorOrigin: undefined,
    machines: [machine],
    machinesRepo: { exists: false, path: '' },
    tailscale: {
      connected: false,
      installed: false,
      ips: [],
      peersOnline: 0,
      serveOrigins: []
    }
  };
}

describe('configured compute inventory', () => {
  test('builds canonical inventory without consulting retired Connector state', async () => {
    const machine = connector();
    const result = await loadConfiguredComputeInventory({
      backend: {
        async getConnectorOverview() {
          return overview(machine);
        }
      },
      userId: 'canonical-user'
    });

    expect(result.connectors).toEqual([machine]);
    expect(result.snapshot.connectors).toEqual([{
      associatedAt: expect.any(String),
      connectorId: 'canonical-machine',
      environmentId: result.snapshot.environments[0]?.id
    }]);
    expect(result.snapshot.environments).toMatchObject([{
      identity: { key: 'environment:canonical-machine', version: 1 },
      kind: 'native_linux',
      name: 'Canonical Linux'
    }]);
    expect(result.snapshot.violations).toEqual([]);
  });
});
