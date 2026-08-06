import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { generatedReleaseChangelogSource } from '../apps/docs/lib/releases/changelog-source';
import { readReleaseCatalog } from '../apps/docs/lib/releases/catalog';
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
import { createPullRequestDevServerConnectorRoutes } from './pr-test-surfaces/connector-http';

export function createProjectSpacePublicApiRoutes(backend: ProjectSpaceBackend) {
  const handlePullRequestDevServer = createPullRequestDevServerConnectorRoutes();
  return async function handleProjectSpacePublicApiRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (await handlePullRequestDevServer(request, response, url)) return true;

    if (request.method === 'GET' && url.pathname === '/api/health') {
      writeJson(response, 200, { ok: true });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/app/meta') {
      writeJson(response, 200, await backend.getAppMeta());
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/app/changelog') {
      const meta = await backend.getAppMeta();
      if (meta.preview?.state !== 'verified') {
        writeJson(response, 409, { error: 'Exact pull request identity is unavailable.' });
        return true;
      }
      const identity = meta.preview.identity;
      const repositoryRoot = process.env.PROJECT_SPACE_BACKEND_REPO_PATH ?? process.cwd();
      const catalog = readReleaseCatalog(resolve(
        repositoryRoot,
        'apps/docs/content/docs/releases/entries'
      ));
      if (!catalog.ok) {
        writeJson(response, 503, { error: 'Exact pull request changelog is unavailable.' });
        return true;
      }
      writeJson(response, 200, {
        identity,
        source: generatedReleaseChangelogSource(
          catalog.catalog.entries.filter(
            (entry) => entry.pullRequest === identity.pullRequestNumber
          )
        )
      });
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
