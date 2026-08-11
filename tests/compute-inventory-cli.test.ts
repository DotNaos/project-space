import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { computeInventoryFromConnectors } from '../server/compute-inventory';
import { createConfiguredComputeInventoryCliHandler } from '../server/compute-inventory-cli/configured-runtime';
import {
  createComputeInventoryCliHttpApi,
  type ComputeInventoryCliHttpService
} from '../server/compute-inventory-cli/http';
import { buildProjectCliComputeInventory } from '../server/compute-inventory-cli/service';
import { getCurrentAuthSession } from '../server/local-auth-store';
import type { ConnectorComputeMetadata } from '../src/shared/compute-environment-api';
import type { MachineRecord } from '../src/shared/project-space-api';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function connector(
  id: string,
  name: string,
  compute: ConnectorComputeMetadata,
  status: MachineRecord['connector']['status'] = 'online'
): MachineRecord {
  return {
    compute,
    connector: {
      capabilities: ['hostd', 'console:jetkvm', 'power:wake-on-lan'],
      installCommand: 'secret installer command',
      lastSeen: '2026-08-11T10:00:00.000Z',
      status
    },
    id,
    kind: 'test',
    name,
    network: {
      sshUser: 'private-user',
      tailscaleIp: '100.64.0.10'
    },
    roles: ['connector'],
    sourcePath: '/private/source/path'
  };
}

function metadata(input: Partial<ConnectorComputeMetadata> & Pick<
  ConnectorComputeMetadata,
  'environmentIdentity' | 'environmentKind' | 'environmentName'
>): ConnectorComputeMetadata {
  return {
    hostEvidence: 'smbios',
    hostIdentity: { key: 'raw-host-identity-never-emit', version: 1 },
    hostName: 'os-pc',
    hostResolution: 'verified',
    platformKind: 'local',
    platformName: 'Local devices',
    resourceMode: 'exclusive',
    resources: {
      architecture: 'x86_64',
      cpu: { cores: 8, model: 'raw-cpu-model' },
      memory: { totalBytes: 32_000 },
      operatingSystem: 'test',
      reportedAt: '2026-08-11T09:59:00.000Z',
      source: 'connector',
      storage: { totalBytes: 1_000_000 }
    },
    ...input
  };
}

function representativeConnectors() {
  return [
    connector('connector-windows', 'Windows', metadata({
      environmentIdentity: { key: 'raw-windows-identity', version: 1 },
      environmentKind: 'native_windows',
      environmentName: 'Windows 01'
    })),
    connector('connector-linux', 'Ubuntu', metadata({
      environmentIdentity: { key: 'raw-linux-identity', version: 1 },
      environmentKind: 'native_linux',
      environmentName: 'Ubuntu native 01'
    }), 'offline'),
    connector('connector-wsl', 'WSL', metadata({
      environmentIdentity: { key: 'raw-wsl-identity', version: 1 },
      environmentKind: 'wsl',
      environmentName: 'WSL Ubuntu 01',
      parentEnvironmentIdentity: { key: 'raw-windows-identity', version: 1 },
      resourceMode: 'shared'
    })),
    connector('connector-codespace', 'Codespace', metadata({
      environmentIdentity: { key: 'raw-codespace-identity', version: 1 },
      environmentKind: 'github_codespace',
      environmentName: 'Project Space 621',
      hostEvidence: 'provider',
      hostIdentity: undefined,
      hostName: undefined,
      hostResolution: 'not_applicable',
      platformKind: 'github_codespaces',
      platformName: 'GitHub Codespaces · DotNaos',
      resourceMode: 'dedicated'
    }))
  ];
}

describe('agent-safe compute inventory', () => {
  test('projects local, WSL, dual-boot, and hostless provider inventory deterministically', () => {
    const connectors = representativeConnectors();
    const first = buildProjectCliComputeInventory({
      checkedAt: '2026-08-11T10:01:00.000Z',
      connectors,
      snapshot: computeInventoryFromConnectors({ connectors })
    });
    const reversed = [...connectors].reverse();
    const second = buildProjectCliComputeInventory({
      checkedAt: '2026-08-11T10:01:00.000Z',
      connectors: reversed,
      snapshot: computeInventoryFromConnectors({ connectors: reversed })
    });

    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(1);
    expect(first.inventoryState).toBe('ready');
    expect(first.hosts).toHaveLength(1);
    expect(first.environmentInstances).toHaveLength(4);
    const codespace = first.environmentInstances.find(({ kind }) => kind === 'github_codespace');
    expect(codespace).toMatchObject({
      hostResolution: 'not_applicable',
      providerLifecycleState: 'unknown',
      workspaceInventory: { state: 'unavailable' },
      workspaces: []
    });
    expect(codespace?.hostId).toBeUndefined();
    expect(codespace?.reference.split('/')[1]).toBe('provider');
    const wsl = first.environmentInstances.find(({ kind }) => kind === 'wsl');
    expect(wsl?.parentEnvironmentInstanceId).toBeTruthy();
    expect(first.hosts[0]?.capabilities).toEqual({
      console: ['jetkvm'],
      power: ['wake-on-lan'],
      state: 'available'
    });
  });

  test('never emits connector paths, network coordinates, models, or raw identity evidence', () => {
    const connectors = representativeConnectors();
    const snapshot = computeInventoryFromConnectors({ connectors });
    snapshot.violations = [{ code: 'duplicate_environment_identity', id: 'raw-duplicate-identity' }];
    const serialized = JSON.stringify(buildProjectCliComputeInventory({
      checkedAt: '2026-08-11T10:01:00.000Z', connectors, snapshot
    }));

    for (const secret of [
      '/private/source/path', '100.64.0.10', 'private-user', 'secret installer command',
      'raw-cpu-model', 'raw-host-identity-never-emit', 'raw-windows-identity',
      'raw-duplicate-identity', 'connector-windows'
    ]) expect(serialized).not.toContain(secret);
    expect(JSON.parse(serialized).violations).toEqual([{
      code: 'duplicate_environment_identity',
      message: 'Compute inventory reported duplicate_environment_identity.'
    }]);
  });

  test('marks offline-only advertised capabilities unavailable', () => {
    const offline = connector('offline-connector', 'Offline', metadata({
      environmentIdentity: { key: 'offline-environment', version: 1 },
      environmentKind: 'native_linux',
      environmentName: 'Offline Linux',
      hostIdentity: { key: 'offline-host', version: 1 },
      hostName: 'offline-host'
    }), 'offline');
    const inventory = buildProjectCliComputeInventory({
      checkedAt: '2026-08-11T10:01:00.000Z',
      connectors: [offline],
      snapshot: computeInventoryFromConnectors({ connectors: [offline] })
    });
    expect(inventory.hosts[0]?.capabilities.state).toBe('unavailable');
    expect(inventory.environmentInstances[0]?.hostd.state).toBe('unavailable');
    expect(inventory.environmentInstances[0]?.accessRoutes[0]?.available).toBe(false);
  });

  test('promotes a child-created parent with the actual parent Host and stays order-independent', () => {
    const parent = connector('parent-connector', 'Parent', metadata({
      environmentIdentity: { key: 'parent-environment', version: 1 },
      environmentKind: 'native_windows',
      environmentName: 'Parent Windows',
      hostIdentity: { key: 'parent-host', version: 1 },
      hostName: 'parent-host'
    }));
    const child = connector('child-connector', 'Child', metadata({
      environmentIdentity: { key: 'child-environment', version: 1 },
      environmentKind: 'wsl',
      environmentName: 'Child WSL',
      hostIdentity: { key: 'child-host', version: 1 },
      hostName: 'child-host',
      parentEnvironmentIdentity: { key: 'parent-environment', version: 1 },
      resourceMode: 'shared'
    }));
    const project = (connectors: MachineRecord[]) => buildProjectCliComputeInventory({
      checkedAt: '2026-08-11T10:01:00.000Z', connectors,
      snapshot: computeInventoryFromConnectors({ connectors })
    });
    const parentFirst = project([parent, child]);
    const childFirst = project([child, parent]);
    expect(childFirst).toEqual(parentFirst);
    const parentInstance = childFirst.environmentInstances.find(({ name }) => name === 'Parent Windows');
    const childInstance = childFirst.environmentInstances.find(({ name }) => name === 'Child WSL');
    expect(parentInstance?.hostId).not.toBe(childInstance?.hostId);
    expect(childFirst.inventoryState).toBe('conflict');
    expect(childFirst.violations.map(({ code }) => code)).toContain('environment_parent_host_mismatch');
  });

  test('orders equivalent connector routes by their emitted capability set', () => {
    const shared = metadata({
      environmentIdentity: { key: 'shared-environment', version: 1 },
      environmentKind: 'native_linux',
      environmentName: 'Shared Linux'
    });
    const first = connector('connector-a', 'A', shared);
    first.connector.capabilities = ['workspace.commands.v1'];
    const second = connector('connector-b', 'B', shared);
    second.connector.capabilities = ['codex.sessions.v1'];
    const project = (connectors: MachineRecord[]) => buildProjectCliComputeInventory({
      checkedAt: '2026-08-11T10:01:00.000Z', connectors,
      snapshot: computeInventoryFromConnectors({ connectors })
    });
    expect(project([second, first])).toEqual(project([first, second]));
  });
});

async function start(handler: ReturnType<typeof createComputeInventoryCliHttpApi>) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await handler(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  return `http://127.0.0.1:${address.port}`;
}

describe('compute inventory CLI HTTP boundary', () => {
  test('is private, read-only, and rejects unsupported requests before dispatch', async () => {
    let calls = 0;
    const service: ComputeInventoryCliHttpService = {
      async list() {
        calls += 1;
        const connectors = representativeConnectors();
        return buildProjectCliComputeInventory({
          checkedAt: '2026-08-11T10:01:00.000Z', connectors,
          snapshot: computeInventoryFromConnectors({ connectors })
        });
      }
    };
    const origin = await start(createComputeInventoryCliHttpApi(
      service,
      async () => ({ callerMachineId: 'caller', userId: 'owner' })
    ));
    const response = await fetch(`${origin}/api/compute/inventory`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(calls).toBe(1);

    for (const [path, method] of [
      ['/api/compute/inventory?fresh=true', 'GET'],
      ['/api/compute/inventory', 'POST']
    ]) {
      const rejected = await fetch(`${origin}${path}`, { method });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect(calls).toBe(1);
  });

  test('binds machine credentials to their owner and rejects a different credential', async () => {
    let observedUser = '';
    const connectors = representativeConnectors();
    const handler = createConfiguredComputeInventoryCliHandler({
      backend: {
        async getConnectorOverview() {
          observedUser = getCurrentAuthSession()?.userId ?? '';
          return {
            machines: connectors,
            machinesRepo: { exists: false, path: '' },
            tailscale: {
              connected: false, installed: false, ips: [], peersOnline: 0, serveOrigins: []
            }
          };
        }
      },
      machineConnection: {
        async resolveMachineCredentialIdentity(token, machineId) {
          return token === 'owner-token' && machineId === 'owner-machine'
            ? { machineId, userId: 'owner-user' }
            : null;
        }
      }
    });
    const origin = await start(handler);
    const authorized = await fetch(`${origin}/api/compute/inventory`, {
      headers: {
        Authorization: 'Bearer owner-token',
        'X-Project-Machine-ID': 'owner-machine'
      }
    });
    expect(authorized.status).toBe(200);
    expect(observedUser).toBe('owner-user');

    observedUser = '';
    const rejected = await fetch(`${origin}/api/compute/inventory`, {
      headers: {
        Authorization: 'Bearer other-token',
        'X-Project-Machine-ID': 'owner-machine'
      }
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({
      error: {
        code: 'authentication_failed',
        message: 'Project Space machine authentication failed.'
      }
    });
    expect(observedUser).toBe('');
  });
});
