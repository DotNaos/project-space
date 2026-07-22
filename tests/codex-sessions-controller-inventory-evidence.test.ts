import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionListRequest,
  CodexSessionListResult,
  CodexSessionsClient
} from '../src/shared/codex-sessions-api';
import type { MachineRuntimeStatusResult } from '../src/shared/project-space-api';
import { CodexSessionsController } from '../src/features/codex-sessions/codex-sessions-controller';

const machineId = 'machine-mac';

function runtimeStatus(instanceId: string): MachineRuntimeStatusResult {
  return {
    capabilities: ['codex.sessions.v1'],
    machineId,
    online: true,
    runtime: {
      architecture: 'arm64',
      buildId: `build-${instanceId}`,
      bundleVersions: {
        connector: '0.4.10',
        machineTools: '0.4.10',
        projectCli: '0.4.10'
      },
      channel: 'stable',
      instanceId,
      lastCheckedAt: '2026-07-21T09:00:00.000Z',
      platform: 'darwin',
      protocolVersion: '1',
      releaseId: 'v0.4.10',
      source: 'managed',
      version: '0.4.10'
    },
    update: { state: 'up-to-date' }
  };
}

function inventory(options: {
  checkedAt?: string;
  inventoryState?: 'live' | 'stale';
  machineName?: string;
  online?: boolean;
  publishedAt?: string;
  statusMessage?: string;
} = {}): CodexSessionListResult {
  return {
    checkedAt: options.checkedAt ?? '2026-07-21T09:00:01.000Z',
    inventoryState: options.inventoryState ?? 'live',
    machine: {
      id: machineId,
      name: options.machineName ?? 'os-macbook',
      online: options.online ?? true,
      statusMessage: options.statusMessage
    },
    publishedAt: options.publishedAt ?? '2026-07-21T09:00:02.000Z',
    sessions: []
  };
}

function clientWithList(
  list: (request: CodexSessionListRequest) => Promise<CodexSessionListResult>
): CodexSessionsClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('Not used by this focused controller test.');
  };
  return {
    approve: unavailable,
    browser: unavailable,
    continue: unavailable,
    interrupt: unavailable,
    list,
    read: unavailable,
    respondToUserInput: unavailable,
    subscribe: () => () => undefined
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, description: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

describe('Codex sessions controller inventory evidence', () => {
  test('loads runtime status before inventory and binds its instance to live evidence', async () => {
    const order: string[] = [];
    const status = runtimeStatus('instance-current');
    const client = clientWithList(async () => {
      order.push('list');
      return inventory();
    });
    const controller = new CodexSessionsController(
      client,
      undefined,
      async () => {
        order.push('runtime');
        return status;
      }
    );

    await controller.loadMachines([machineId]);

    expect(order).toEqual(['runtime', 'list']);
    expect(controller.getState().runtimeByMachineId[machineId]).toEqual(status);
    expect(controller.getState().machines).toEqual([
      expect.objectContaining({
        id: machineId,
        inventoryConnectorInstanceId: 'instance-current',
        inventoryState: 'live',
        status: 'connected'
      })
    ]);
  });

  test('preserves stale offline inventory evidence without presenting it as live', async () => {
    const client = clientWithList(async () => inventory({
      checkedAt: '2026-07-21T08:58:00.000Z',
      inventoryState: 'stale',
      online: false,
      publishedAt: '2026-07-21T08:58:01.000Z',
      statusMessage: 'Saved inventory; connector is offline.'
    }));
    const controller = new CodexSessionsController(client);

    await controller.loadMachines([machineId], { [machineId]: 'instance-last-seen' });

    expect(controller.getState().machines).toEqual([
      expect.objectContaining({
        id: machineId,
        inventoryCheckedAt: '2026-07-21T08:58:00.000Z',
        inventoryConnectorInstanceId: 'instance-last-seen',
        inventoryPublishedAt: '2026-07-21T08:58:01.000Z',
        inventoryState: 'stale',
        status: 'offline',
        statusDetail: 'Saved inventory; connector is offline.'
      })
    ]);
  });

  test('does not let an older overlapping response replace newer connector-instance evidence', async () => {
    const firstInventory = deferred<CodexSessionListResult>();
    const secondInventory = deferred<CodexSessionListResult>();
    const statuses = [runtimeStatus('instance-old'), runtimeStatus('instance-new')];
    let listCalls = 0;
    let runtimeCalls = 0;
    const client = clientWithList(async () => {
      listCalls += 1;
      return listCalls === 1 ? firstInventory.promise : secondInventory.promise;
    });
    const controller = new CodexSessionsController(
      client,
      undefined,
      async () => statuses[runtimeCalls++]!
    );

    const firstLoad = controller.loadMachines([machineId]);
    await waitFor(() => listCalls === 1, 'the first inventory request');
    const secondLoad = controller.loadMachines([machineId]);
    await waitFor(() => listCalls === 2, 'the second inventory request');

    secondInventory.resolve(inventory({
      checkedAt: '2026-07-21T09:02:00.000Z',
      machineName: 'os-macbook-new',
      publishedAt: '2026-07-21T09:02:01.000Z'
    }));
    await secondLoad;
    firstInventory.resolve(inventory({
      checkedAt: '2026-07-21T09:01:00.000Z',
      machineName: 'os-macbook-old',
      publishedAt: '2026-07-21T09:01:01.000Z'
    }));
    await firstLoad;

    expect(controller.getState().runtimeByMachineId[machineId]?.runtime?.instanceId)
      .toBe('instance-new');
    expect(controller.getState().machines).toEqual([
      expect.objectContaining({
        inventoryCheckedAt: '2026-07-21T09:02:00.000Z',
        inventoryConnectorInstanceId: 'instance-new',
        inventoryPublishedAt: '2026-07-21T09:02:01.000Z',
        name: 'os-macbook-new'
      })
    ]);
  });

  test('clears a machine refresh error after that machine recovers', async () => {
    let available = false;
    const controller = new CodexSessionsController(clientWithList(async () => {
      if (!available) throw new Error('Connector is temporarily unavailable.');
      return inventory();
    }));

    await controller.loadMachines([machineId]);
    expect(controller.getState().errorMessage).toBeUndefined();
    expect(controller.getState().machines).toEqual([
      expect.objectContaining({
        id: machineId,
        status: 'unavailable',
        statusDetail: 'Connector is temporarily unavailable.'
      })
    ]);

    available = true;
    await controller.loadMachines([machineId]);
    expect(controller.getState().machines).toEqual([
      expect.objectContaining({ id: machineId, inventoryState: 'live', status: 'connected' })
    ]);
    expect(controller.getState().machines[0]?.statusDetail).toBeUndefined();
  });

  test('continues to live inventory when runtime status never resolves', async () => {
    let listCalls = 0;
    let runtimeAborted = false;
    const controller = new CodexSessionsController(
      clientWithList(async () => {
        listCalls += 1;
        return inventory();
      }),
      undefined,
      (_machineId, signal) => new Promise<MachineRuntimeStatusResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          runtimeAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
      5
    );

    await controller.loadMachines([machineId], { [machineId]: 'instance-overview' });

    expect(listCalls).toBe(1);
    expect(runtimeAborted).toBe(true);
    expect(controller.getState().runtimeByMachineId[machineId]).toBeUndefined();
    expect(controller.getState().machines).toEqual([
      expect.objectContaining({
        inventoryConnectorInstanceId: 'instance-overview',
        inventoryState: 'live',
        status: 'connected'
      })
    ]);
  });
});
