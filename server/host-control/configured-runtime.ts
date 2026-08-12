import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import type { ProjectSpaceBackend } from '../../src/shared/project-space-api';
import { createCodexMachineTasksAuthResolver } from '../codex-machine-tasks/auth-context';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured,
  listPhysicalMachines
} from '../local-database-store';
import { isProjectSpaceAuthRequired, readAuthSessionFromRequest } from '../local-auth-store';
import type { MachineConnectionRuntime } from '../machine-connection-runtime';
import { loadMachinePowerBindings } from '../machine-power/config';
import { createJetKvmMqttProvider } from '../machine-power/provider';
import { createMachinePowerService } from '../machine-power/service';
import { PostgresMachinePowerOperationStore } from '../machine-power/store';
import { writeJson } from '../project-space-http-response';
import type { HostControlBinding, HostControlPolicy } from './contracts';
import { createHostControlHttpApi } from './http';
import { createMachinePowerHostControlProvider } from './machine-power-provider';
import { PostgresHostControlOperationStore } from './postgres-store';
import { createHostControlService } from './service';

const route = /^\/api\/compute\/hosts\/[^/]+\/(status|console\/screenshot|operations)$/;

export function createConfiguredHostControlHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  let runtime: Promise<ReturnType<typeof createHostControlHttpApi>> | undefined;
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!route.test(url.pathname)) return false;
    if (!isDatabaseConfigured()) return unavailable(response);
    try {
      runtime ??= createHandler(options);
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      return unavailable(response);
    }
  };
}

async function createHandler(options: {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}) {
  const database = await getMachineConnectionDatabaseClient();
  const power = createMachinePowerService({
    bindings: () => loadMachinePowerBindings(configRoot()),
    inventory: listPhysicalMachines,
    operations: new PostgresMachinePowerOperationStore(database),
    provider: createJetKvmMqttProvider()
  });
  const bindings = async () => configuredBindings(options.backend);
  const service = createHostControlService({
    bindings,
    inventory: {
      async resolve(ownerUserId, selector) {
        const inventory = await loadConfiguredComputeInventory({
          backend: options.backend, userId: ownerUserId
        });
        const exactId = inventory.snapshot.hosts.filter(({ id }) => id === selector);
        if (exactId.length === 1) return { ...exactId[0]!, resolution: 'resolved' as const };
        const exactName = inventory.snapshot.hosts.filter(({ name }) => name === selector);
        if (exactName.length === 1) return { ...exactName[0]!, resolution: 'resolved' as const };
        return { resolution: exactName.length > 1 ? 'ambiguous' as const : 'missing' as const };
      }
    },
    operations: new PostgresHostControlOperationStore(database),
    policy: configuredPolicy(),
    provider: createMachinePowerHostControlProvider(power)
  });
  const resolveActor = createCodexMachineTasksAuthResolver({
    authenticateMachine: async ({ machineId, token }) => (
      options.machineConnection?.resolveMachineCredentialIdentity(token, machineId) ?? null
    ),
    authRequired: isProjectSpaceAuthRequired,
    readHuman: async (request) => {
      const session = await readAuthSessionFromRequest(request);
      return session ? { userId: session.userId } : null;
    }
  });
  return createHostControlHttpApi(service, resolveActor);
}

async function configuredBindings(
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>
): Promise<HostControlBinding[]> {
  const configured = await loadMachinePowerBindings(configRoot());
  const byOwner = new Map<string, Awaited<ReturnType<typeof loadConfiguredComputeInventory>>>();
  const result: HostControlBinding[] = [];
  for (const entry of configured) {
    let inventory = byOwner.get(entry.machine.ownerUserId);
    if (!inventory) {
      inventory = await loadConfiguredComputeInventory({
        backend, userId: entry.machine.ownerUserId
      });
      byOwner.set(entry.machine.ownerUserId, inventory);
    }
    const host = inventory.snapshot.hosts.find(({ id, name }) =>
      id === entry.machine.physicalMachineId && name === entry.machine.selector
    );
    if (!host) continue;
    const providerId = `jetkvm-${createHash('sha256').update(JSON.stringify([
      entry.machine.ownerUserId, host.id, entry.provider.deviceId
    ])).digest('hex').slice(0, 24)}`;
    const revision = createHash('sha256').update(JSON.stringify([
      entry.machine.ownerUserId, host.id, providerId, entry.provider.firmwareCompatibility,
      ['status', 'on'], []
    ])).digest('hex');
    result.push({
      bindingRevision: revision,
      capabilities: {
        available: true,
        console: [],
        hostId: host.id,
        power: ['status', 'on'],
        provider: { id: providerId, kind: 'jetkvm' },
        schemaVersion: 1
      },
      machinePower: { physicalMachineId: entry.machine.physicalMachineId },
      ownerUserId: entry.machine.ownerUserId
    });
  }
  return result;
}

function configuredPolicy(): HostControlPolicy {
  const permitted = new Set(['host.status', 'host.power.on', 'host.console.screenshot']);
  return {
    async admit({ actor, capability }) {
      return Boolean(actor.userId) && /^host\.(?:status|power\.(?:on|off)|console\.[a-z_]+)$/.test(capability);
    },
    async authorize(input) {
      const allowed = input.risk === 'standard' && permitted.has(input.capability);
      const decisionId = createHash('sha256').update(JSON.stringify([
        input.actor.userId, input.actor.callerMachineId ?? null, input.hostId,
        input.bindingRevision, input.capability, input.risk, input.approvalId ?? null
      ])).digest('hex');
      return {
        allowed,
        decisionId,
        expiresAt: new Date(Date.now() + 15_000).toISOString()
      };
    }
  };
}

function configRoot() {
  return process.env.PROJECT_SPACE_MACHINE_POWER_CONFIG_ROOT ?? resolve(process.cwd(), 'config/machine-power');
}

function unavailable(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store');
  writeJson(response, 503, {
    error: { code: 'host_control_unavailable', message: 'Host control is not configured.' }
  });
  return true;
}
