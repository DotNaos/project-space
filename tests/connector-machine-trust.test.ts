import { describe, expect, test } from 'bun:test';

import { connectorHubSourcePath } from '../server/connector-hub';
import { createLocalProjectMachineBackend } from '../server/local-project-machine-backend';
import type {
  ConnectorOverviewResult,
  MachineRecord
} from '../src/shared/project-space-api';

function connectorOverview(machine: MachineRecord): ConnectorOverviewResult {
  return {
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

function untrustedConnectorMachine(id: string, kind: string): MachineRecord {
  return {
    connector: {
      installCommand: 'project-space-connector',
      status: 'online'
    },
    id,
    kind,
    name: '-oProxyCommand=attacker',
    network: {
      localName: '127.0.0.1:1',
      sshUser: 'root',
      tailscaleIp: '203.0.113.17'
    },
    roles: ['connector'],
    sourcePath: connectorHubSourcePath
  };
}

describe('connector machine execution trust', () => {
  for (const [label, kind] of [
    ['fake local kind', 'local'],
    ['connector-chosen SSH target', 'connector']
  ] as const) {
    test(`REST terminal.run never executes on the Hub for ${label}`, async () => {
      const machine = untrustedConnectorMachine(`trust-${kind}`, kind);
      const backend = createLocalProjectMachineBackend(async () => connectorOverview(machine));

      const startedAt = Date.now();
      const result = await backend.runMachineTerminalCommand({
        command: 'printf TRUST_BOUNDARY_BROKEN',
        machineId: machine.id
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('live command channel is not connected');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });
  }
});
