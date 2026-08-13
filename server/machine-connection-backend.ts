import type { IncomingMessage } from 'node:http';

import { createMachineConnectionApiHandler } from './machine-connection-api';
import {
  DatabaseMachineConnectionStore,
  type TransactionalDatabaseQueryClient
} from './machine-connection-database-store';
import { createMachineConnectionRateLimiter } from './machine-connection-rate-limit';
import { MachineConnectionService } from './machine-connection-service';

export interface MachineConnectionBackendOptions {
  databaseClient: TransactionalDatabaseQueryClient;
  onMachineRevoked?(machineId: string): void | Promise<void>;
  publicOrigin: string;
  rateLimitSecret: Uint8Array;
  readAuthenticatedUserId(request: IncomingMessage): Promise<string | null>;
}

export function createMachineConnectionBackend(
  options: MachineConnectionBackendOptions
) {
  const store = new DatabaseMachineConnectionStore(options.databaseClient);
  const rateLimiter = createMachineConnectionRateLimiter({
    client: options.databaseClient,
    hmacSecret: options.rateLimitSecret
  });
  const service = new MachineConnectionService({
    onMachineRevoked: options.onMachineRevoked,
    publicOrigin: options.publicOrigin,
    store
  });

  async function resolveMachineCredentialIdentity(token: string, machineId: string) {
    try {
      const machine = await service.markMachineOnline(machineId, token);
      return {
        connectorProfile: machine.connectorProfile,
        hostId: machine.hostname,
        machineId: machine.id,
        userId: machine.ownerUserId
      };
    } catch {
      return null;
    }
  }

  return {
    cleanupExpiredRequests: () => store.cleanupOldRequests(),
    cleanupRateLimitEvents: () => rateLimiter.cleanupOldEvents(),
    handleRequest: createMachineConnectionApiHandler({
      allowCreateRequest: (request) => rateLimiter.allowCreateRequest(request),
      readAuthenticatedUserId: options.readAuthenticatedUserId,
      service
    }),
    resolveMachineCredentialIdentity
  };
}
