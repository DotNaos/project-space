import type {
  ConnectorOverviewResult,
  MachineRecord,
  MachineRuntimeOperationRequest
} from '../src/shared/project-space-api';
import { requestConnectorRuntimeMaintenance } from './connector-runtime-command-routing';
import { requestConnectorRuntimeStop } from './connector-runtime-stop-routing';
import { ConnectorRuntimeStopService } from './connector-runtime-stop-service';
import {
  ConnectorRuntimeMaintenanceService
} from './connector-runtime-maintenance-service';
import { ConfiguredConnectorRuntimeOperationStore } from './connector-runtime-operation-store-provider';
import { ConnectorRuntimeMaintenanceWindowRateLimiter } from './connector-runtime-rate-limiter';
import {
  ConnectorRuntimeReleaseSourceError,
  GitHubConnectorRuntimeReleaseSource,
  configuredConnectorRuntimeReleaseId,
  configuredConnectorRuntimeReleasePublicKey
} from './connector-runtime-release-source';
import {
  isDatabaseConfigured,
  listPhysicalMachines,
  readMachineMembership
} from './local-database-store';
import {
  getCurrentAuthSession,
  isProjectSpaceAuthRequired
} from './local-auth-store';

interface ConfiguredConnectorRuntimeOptions {
  loadOverview(): Promise<ConnectorOverviewResult>;
}

function currentUserId() {
  const userId = getCurrentAuthSession()?.userId;
  if (userId) return userId;
  if (!isProjectSpaceAuthRequired()) return 'local-development-user';
  throw new Error('Login required.');
}

export function createConfiguredConnectorRuntime({
  loadOverview
}: ConfiguredConnectorRuntimeOptions) {
  const releaseId = configuredConnectorRuntimeReleaseId();
  const releaseSource = releaseId
    ? new GitHubConnectorRuntimeReleaseSource(releaseId)
    : {
        async loadApprovedManifest() {
          throw new ConnectorRuntimeReleaseSourceError('invalid-configuration');
        }
      };
  const directory = {
    async canAutomaticallyUpdate(machineId: string, ownerUserId?: string) {
      const overview = await loadOverview();
      const physicalMachines = isDatabaseConfigured() && ownerUserId
        ? await listPhysicalMachines(ownerUserId).catch(() => [])
        : overview.physicalMachines ?? [];
      const scopes = physicalMachines.filter((physicalMachine) =>
        physicalMachine.connectorIds.includes(machineId)
      );
      if (scopes.length !== 1) return false;
      const connectorIds = new Set(scopes[0]!.connectorIds);
      const live = overview.machines.filter((machine) =>
        connectorIds.has(machine.id) &&
        (machine.connector.status === 'online' || machine.connector.status === 'local')
      );
      return live.length === 1 && live[0]!.id === machineId;
    },
    async readMachine(machineId: string) {
      return (await loadOverview()).machines.find((machine) => machine.id === machineId) ?? null;
    },
    async readMembership({ machineId, userId }: { machineId: string; userId: string }) {
      if (!isProjectSpaceAuthRequired()) return { role: 'owner' as const };
      if (!isDatabaseConfigured()) return null;
      return readMachineMembership({ machineId, userId });
    }
  };
  const service = new ConnectorRuntimeMaintenanceService({
    directory,
    dispatcher: {
      dispatch: requestConnectorRuntimeMaintenance
    },
    manifestPublicKey: configuredConnectorRuntimeReleasePublicKey(),
    operations: new ConfiguredConnectorRuntimeOperationStore(),
    rateLimiter: new ConnectorRuntimeMaintenanceWindowRateLimiter(),
    releases: releaseSource
  });
  const stopService = new ConnectorRuntimeStopService({
    directory,
    dispatcher: {
      dispatch({ plan, userId }) {
        return requestConnectorRuntimeStop(plan, userId);
      }
    }
  });

  return {
    async continueMaintenance(machine: MachineRecord, ownerUserId?: string) {
      await service.continueMaintenance(machine, ownerUserId);
    },
    decideReconnect(machine: MachineRecord) {
      return service.decideReconnect(machine);
    },
    async enrichOverview(overview: ConnectorOverviewResult): Promise<ConnectorOverviewResult> {
      const machines = await Promise.all(overview.machines.map(async (machine) => {
        const status = await service.statusForMachine(machine).catch(() => undefined);
        if (!status) return machine;
        return {
          ...machine,
          connector: {
            ...machine.connector,
            capabilities: status.capabilities,
            ...(status.runtime ? { runtime: status.runtime } : {}),
            update: status.update
          }
        };
      }));
      return { ...overview, machines };
    },
    getMachineRuntime(machineId: string) {
      return service.status(machineId);
    },
    prepareReconnect(machine: MachineRecord, ownerUserId?: string) {
      return service.prepareReconnect(machine, ownerUserId);
    },
    startMachineRuntimeOperation(machineId: string, request: MachineRuntimeOperationRequest) {
      return service.request({ ...request, machineId }, currentUserId());
    },
    stopMachineRuntime(machineId: string) {
      return stopService.request({ machineId }, currentUserId());
    }
  };
}

export type ConfiguredConnectorRuntime = ReturnType<typeof createConfiguredConnectorRuntime>;
