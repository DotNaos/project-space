import type {
  ConnectorOverviewResult,
  MachineRecord,
  MachineRuntimeOperationRequest
} from '../src/shared/project-space-api';
import { requestConnectorRuntimeMaintenance } from './connector-runtime-command-routing';
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
  const service = new ConnectorRuntimeMaintenanceService({
    directory: {
      async readMachine(machineId) {
        return (await loadOverview()).machines.find((machine) => machine.id === machineId) ?? null;
      },
      async readMembership({ machineId, userId }) {
        if (!isProjectSpaceAuthRequired()) return { role: 'owner' };
        if (!isDatabaseConfigured()) return null;
        return readMachineMembership({ machineId, userId });
      }
    },
    dispatcher: {
      dispatch: requestConnectorRuntimeMaintenance
    },
    manifestPublicKey: configuredConnectorRuntimeReleasePublicKey(),
    operations: new ConfiguredConnectorRuntimeOperationStore(),
    rateLimiter: new ConnectorRuntimeMaintenanceWindowRateLimiter(),
    releases: releaseSource
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
    }
  };
}

export type ConfiguredConnectorRuntime = ReturnType<typeof createConfiguredConnectorRuntime>;
