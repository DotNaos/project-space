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
    decideReconnect(machine: MachineRecord) {
      return service.decideReconnect(machine);
    },
    getMachineRuntime(machineId: string) {
      return service.status(machineId);
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
