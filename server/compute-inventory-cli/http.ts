import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  ProjectCliComputeInventory,
  ProjectCliInventorySchemaVersion
} from '../../src/shared/compute-inventory-cli-api';
import {
  projectCliInventoryLegacySchemaVersion,
  projectCliInventoryHostdSchemaVersion,
  projectCliInventorySchemaVersion
} from '../../src/shared/compute-inventory-cli-api';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';

const inventoryRoute = '/api/compute/inventory';
export const computeInventoryV2MediaType =
  'application/vnd.project-space.compute-inventory+json; version=2';
export const computeInventoryV3MediaType =
  'application/vnd.project-space.compute-inventory+json; version=3';

export interface ComputeInventoryCliActor {
  callerMachineId?: string;
  userId: string;
}

export interface ComputeInventoryCliHttpService {
  list(
    actor: ComputeInventoryCliActor,
    schemaVersion: ProjectCliInventorySchemaVersion
  ): Promise<ProjectCliComputeInventory>;
}

const compatibilitySurfaceHeader = 'x-project-compatibility-surface';
const inventoryCompatibilitySurfaces = new Set([
  'connector.machine-list.cli.v1',
  'connector.machine-show.cli.v1'
]);

export function createComputeInventoryCliHttpApi(
  service: ComputeInventoryCliHttpService,
  resolveActor: (request: IncomingMessage) => Promise<ComputeInventoryCliActor>,
  options: {
    recordCompatibilityUse?(ownerUserId: string, surface: string): Promise<unknown>;
  } = {}
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
      const schemaVersion = requestedSchemaVersion(request.headers.accept);
      if (!schemaVersion) {
        writeJson(response, 406, {
          error: {
            code: 'unsupported_inventory_version',
            message: 'The requested compute inventory representation is not supported.'
          }
        });
        return true;
      }
      const actor = await resolveActor(request);
      const result = await service.list(actor, schemaVersion);
      writeJson(response, 200, result);
      const compatibilitySurface = request.headers[compatibilitySurfaceHeader];
      if (typeof compatibilitySurface === 'string' &&
          inventoryCompatibilitySurfaces.has(compatibilitySurface)) {
        await options.recordCompatibilityUse?.(actor.userId, compatibilitySurface);
      }
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

function requestedSchemaVersion(accept: string | undefined): ProjectCliInventorySchemaVersion | null {
  if (!accept || accept.split(',').some((value) => {
    const mediaType = value.split(';', 1)[0]?.trim().toLowerCase();
    return mediaType === '*/*' || mediaType === 'application/json';
  })) return projectCliInventoryLegacySchemaVersion;
  if (accept.split(',').some((value) => value.trim().toLowerCase() === computeInventoryV2MediaType)) {
    return projectCliInventorySchemaVersion;
  }
  if (accept.split(',').some((value) => value.trim().toLowerCase() === computeInventoryV3MediaType)) {
    return projectCliInventoryHostdSchemaVersion;
  }
  return null;
}
