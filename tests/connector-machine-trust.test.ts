import { describe, expect, test } from 'bun:test';

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
    sourcePath: 'connector-hub'
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
      expect(result.stderr).toContain('canonical Environment and Workspace Runtime');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });
  }

  test('remote Connector filesystem and worktree actions fail closed', async () => {
    const machine = untrustedConnectorMachine('trust-filesystem', 'connector');
    const backend = createLocalProjectMachineBackend(async () => connectorOverview(machine));

    await expect(backend.loadProjectWorktrees('/tmp/project', machine.id)).rejects.toThrow(
      'canonical Environment and Workspace Runtime'
    );
    await expect(backend.getMachineFileSystemRoot({ machineId: machine.id })).resolves.toMatchObject({
      errorCode: 'unsupported',
      message: expect.stringContaining('canonical Environment and Workspace Runtime'),
      status: 'error'
    });
    await expect(backend.createMachineDirectory({
      machineId: machine.id,
      name: 'should-not-exist',
      parentPath: '/tmp'
    })).resolves.toMatchObject({
      errorCode: 'unsupported',
      message: expect.stringContaining('canonical Environment and Workspace Runtime'),
      status: 'error'
    });
  });
});
