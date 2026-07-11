import type { IncomingMessage } from "node:http";

import { createMachineConnectionApiHandler } from "./machine-connection-api";
import {
  DatabaseMachineConnectionStore,
  type TransactionalDatabaseQueryClient,
} from "./machine-connection-database-store";
import { createMachineConnectionRateLimiter } from "./machine-connection-rate-limit";
import { MachineConnectionService } from "./machine-connection-service";

export interface MachineConnectionBackendOptions {
  databaseClient: TransactionalDatabaseQueryClient;
  isMachineOnline(machineId: string): boolean | Promise<boolean>;
  publicOrigin: string;
  rateLimitSecret: Uint8Array;
  readAuthenticatedUserId(request: IncomingMessage): Promise<string | null>;
}

export function createMachineConnectionBackend(
  options: MachineConnectionBackendOptions,
) {
  const store = new DatabaseMachineConnectionStore(options.databaseClient);
  const rateLimiter = createMachineConnectionRateLimiter({
    client: options.databaseClient,
    hmacSecret: options.rateLimitSecret,
  });
  const service = new MachineConnectionService({
    isMachineOnline: options.isMachineOnline,
    publicOrigin: options.publicOrigin,
    store,
  });

  return {
    cleanupExpiredRequests: () => store.cleanupOldRequests(),
    cleanupRateLimitEvents: () => rateLimiter.cleanupOldEvents(),
    handleRequest: createMachineConnectionApiHandler({
      allowCreateRequest: (request) => rateLimiter.allowCreateRequest(request),
      readAuthenticatedUserId: options.readAuthenticatedUserId,
      service,
    }),
  };
}
