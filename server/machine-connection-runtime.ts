import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createMachineConnectionBackend,
  type MachineConnectionBackendOptions
} from './machine-connection-backend';
import {
  disconnectConnectorCommandChannel,
  isConnectorCommandChannelAuthenticated
} from './connector-command-hub';
import {
  readMachineConnectionPublicOrigin,
  readMachineConnectionRateLimitSecret
} from './machine-connection-environment';
import {
  isProjectSpaceAuthRequired,
  isProjectSpacePreviewRuntime,
  readAuthSessionFromRequest
} from './local-auth-store';
import { getMachineConnectionDatabaseClient } from './local-database-store';
import type { TrustedMachineCredentialIdentity } from './machine-connection-contract';
import { projectSpaceLogger, recordObservedError } from './observability';

const defaultCleanupIntervalMs = 60 * 60 * 1_000;

interface MachineConnectionRuntimeScheduler {
  clearInterval(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
}

export interface MachineConnectionRuntimeOptions extends MachineConnectionBackendOptions {
  cleanupIntervalMs?: number;
  onMaintenanceError?(message: string): void;
  scheduler?: MachineConnectionRuntimeScheduler;
}

export interface MachineConnectionRuntime {
  authenticateConnectorCredential(token: string, machineId: string): Promise<boolean>;
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<boolean>;
  runMaintenance(): Promise<void>;
  resolveMachineCredentialIdentity(
    token: string,
    machineId: string
  ): Promise<TrustedMachineCredentialIdentity | null>;
  start(): void;
  stop(): Promise<void>;
}

const nodeScheduler: MachineConnectionRuntimeScheduler = {
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setInterval(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref();
    return timer;
  }
};

export function createMachineConnectionRuntime(
  options: MachineConnectionRuntimeOptions
): MachineConnectionRuntime {
  const backend = createMachineConnectionBackend({
    ...options,
    onMachineRevoked:
      options.onMachineRevoked ??
      ((machineId) => {
        disconnectConnectorCommandChannel(machineId);
      })
  });
  const scheduler = options.scheduler ?? nodeScheduler;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? defaultCleanupIntervalMs;
  if (!Number.isSafeInteger(cleanupIntervalMs) || cleanupIntervalMs < 1_000) {
    throw new Error('Machine connection cleanup interval must be at least one second.');
  }

  let cleanupTimer: unknown;
  let maintenance: Promise<void> | null = null;
  let started = false;

  function reportMaintenanceError(errors: unknown[]) {
    const message = 'Machine connection maintenance failed.';
    if (options.onMaintenanceError) {
      options.onMaintenanceError(message);
      return;
    }
    recordObservedError('machine_connection', 'maintenance_failed');
    projectSpaceLogger.error('machine_connection.maintenance.failed', {
      component: 'machine-connection',
      failureCount: errors.length
    }, errors[0]);
  }

  function runMaintenance() {
    if (maintenance) {
      return maintenance;
    }

    maintenance = Promise.allSettled([
      backend.cleanupExpiredRequests(),
      backend.cleanupRateLimitEvents()
    ])
      .then((results) => {
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (errors.length > 0) {
          reportMaintenanceError(errors);
        }
      })
      .finally(() => {
        maintenance = null;
      });
    return maintenance;
  }

  return {
    authenticateConnectorCredential: backend.authenticateConnectorCredential,
    handleRequest: backend.handleRequest,
    resolveMachineCredentialIdentity: backend.resolveMachineCredentialIdentity,
    runMaintenance,
    start() {
      if (started) {
        return;
      }
      void runMaintenance();
      cleanupTimer = scheduler.setInterval(() => {
        void runMaintenance();
      }, cleanupIntervalMs);
      started = true;
    },
    async stop() {
      if (started) {
        scheduler.clearInterval(cleanupTimer);
        cleanupTimer = undefined;
        started = false;
      }
      await maintenance;
    }
  };
}

export async function createConfiguredMachineConnectionRuntime(
  environment: NodeJS.ProcessEnv = process.env
) {
  if (isProjectSpacePreviewRuntime(environment)) {
    return null;
  }
  const publicOrigin = readMachineConnectionPublicOrigin(environment);
  if (!publicOrigin) {
    return null;
  }
  const rateLimitSecret = readMachineConnectionRateLimitSecret(environment);
  const databaseClient = await getMachineConnectionDatabaseClient();

  return createMachineConnectionRuntime({
    databaseClient,
    isMachineOnline: isConnectorCommandChannelAuthenticated,
    publicOrigin,
    rateLimitSecret,
    async readAuthenticatedUserId(request) {
      if (!isProjectSpaceAuthRequired()) {
        return 'local-development-user';
      }
      return (await readAuthSessionFromRequest(request))?.userId ?? null;
    }
  });
}
