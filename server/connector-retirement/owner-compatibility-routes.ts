import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  PhysicalMachineRecord,
  ProjectSpaceBackend
} from '../../src/shared/project-space-api';
import { loadConfiguredComputeInventory } from '../configured-compute-inventory';
import {
  isDatabaseConfigured,
  listConnectorCredentials,
  revokeConnectorCredential
} from '../local-database-store';
import { writeJson } from '../project-space-http-response';
import { recordSuccessfulConnectorCompatibilityUse } from './configured-runtime';

export function createConnectorOwnerCompatibilityRoutes(options: {
  backend: ProjectSpaceBackend;
  loadPhysicalMachines(userId: string): Promise<PhysicalMachineRecord[]>;
  recordCompatibilityUse?: typeof recordSuccessfulConnectorCompatibilityUse;
}) {
  const recordUse = options.recordCompatibilityUse ?? recordSuccessfulConnectorCompatibilityUse;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    userId: string
  ) => {
    if (request.method === 'GET' && url.pathname === '/api/connectors/credentials') {
      response.setHeader('Cache-Control', 'no-store');
      writeJson(response, 200, {
        credentials: isDatabaseConfigured() ? await listConnectorCredentials(userId) : []
      });
      await recordUse(userId, 'connector.credentials.http.v1');
      return true;
    }

    const credential = url.pathname.match(
      /^\/api\/connectors\/credentials\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
    )?.[1];
    if (request.method === 'DELETE' && credential) {
      response.setHeader('Cache-Control', 'no-store');
      const revoked = await revokeConnectorCredential({ credentialId: credential, userId });
      writeJson(response, 200, { revoked });
      if (revoked) await recordUse(userId, 'connector.credentials.http.v1');
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/connectors/overview') {
      const overview = await options.backend.getConnectorOverview();
      const physicalMachines = await options.loadPhysicalMachines(userId);
      const { snapshot: computeInventory } = await loadConfiguredComputeInventory({
        backend: options.backend,
        overview: { ...overview, physicalMachines },
        userId
      });
      writeJson(response, 200, { ...overview, computeInventory, physicalMachines });
      await recordUse(userId, 'connector.overview.http.v1');
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/connectors/project-registry') {
      writeJson(response, 200, await options.backend.getConnectorProjectRegistry());
      await recordUse(userId, 'connector.project-registry.owner-http.v1');
      return true;
    }
    return false;
  };
}
