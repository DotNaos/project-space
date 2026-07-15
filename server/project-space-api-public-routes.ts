import type { IncomingMessage, ServerResponse } from 'node:http';

import { isConnectorHubMessage } from './connector-command-protocol';
import { registerConnectorProjectRegistry } from './connector-hub';
import {
  requestConnectorToken,
  resolveConnectorMachineTokenIdentity
} from './connector-registration-auth';
import {
  getProjectSpaceAuthSessionResult,
  readAuthTokenFromRequest,
  revokeProjectSpaceAuthSession
} from './local-auth-store';
import { readJson, writeJson } from './project-space-http-response';
import type {
  ConnectorProjectRegistryResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

export function createProjectSpacePublicApiRoutes(backend: ProjectSpaceBackend) {
  return async function handleProjectSpacePublicApiRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (request.method === 'GET' && url.pathname === '/api/health') {
      writeJson(response, 200, { ok: true });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/app/meta') {
      writeJson(response, 200, await backend.getAppMeta());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/session') {
      writeJson(
        response,
        200,
        await getProjectSpaceAuthSessionResult(readAuthTokenFromRequest(request))
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      revokeProjectSpaceAuthSession();
      writeJson(response, 200, { ok: true });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/connectors/project-registry') {
      const payload = await readJson<ConnectorProjectRegistryResult>(request);
      if (!isConnectorHubMessage({ payload, type: 'connector.registry' })) {
        writeJson(response, 400, { error: 'Invalid connector registry.' });
        return true;
      }
      const identity = await resolveConnectorMachineTokenIdentity(
        requestConnectorToken(request),
        payload.connector.machineId
      );
      if (!identity) {
        writeJson(response, 401, { error: 'Connector registration token required.' });
        return true;
      }

      await registerConnectorProjectRegistry(payload, identity.connectorProfile);
      writeJson(response, 200, { ok: true });
      return true;
    }

    return false;
  };
}
