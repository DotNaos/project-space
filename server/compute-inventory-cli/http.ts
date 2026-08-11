import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectCliComputeInventory } from '../../src/shared/compute-inventory-cli-api';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';

const inventoryRoute = '/api/compute/inventory';

export interface ComputeInventoryCliActor {
  callerMachineId?: string;
  userId: string;
}

export interface ComputeInventoryCliHttpService {
  list(actor: ComputeInventoryCliActor): Promise<ProjectCliComputeInventory>;
}

export function createComputeInventoryCliHttpApi(
  service: ComputeInventoryCliHttpService,
  resolveActor: (request: IncomingMessage) => Promise<ComputeInventoryCliActor>
) {
  return async function handleComputeInventoryCliHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== inventoryRoute) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (request.method !== 'GET' || [...url.searchParams.keys()].length > 0) {
        writeJson(response, 400, {
          error: {
            code: 'invalid_request',
            message: 'Compute inventory requests do not accept query parameters.'
          }
        });
        return true;
      }
      writeJson(response, 200, await service.list(await resolveActor(request)));
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: {
            code: 'authentication_failed',
            message: 'Project Space machine authentication failed.'
          }
        });
      } else {
        writeJson(response, 503, {
          error: {
            code: 'inventory_unavailable',
            message: 'The Project Space compute inventory is temporarily unavailable.'
          }
        });
      }
    }
    return true;
  };
}
