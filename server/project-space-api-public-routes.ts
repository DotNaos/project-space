import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { readExactPullRequestChangelogSource } from './pr-preview-changelog-source';
import { releaseChangelogForVersion } from './release-changelog';
import { recordSuccessfulConnectorCompatibilityUse } from './connector-retirement/configured-runtime';
import { meaningfulNetworkEvidence } from './connector-command-upgrade-handler';

const exactSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createProjectSpacePublicApiRoutes(
  backend: ProjectSpaceBackend,
  options: { recordCompatibilityUse?: typeof recordSuccessfulConnectorCompatibilityUse } = {}
) {
  const recordCompatibilityUse = options.recordCompatibilityUse ??
    recordSuccessfulConnectorCompatibilityUse;
  const handlePullRequestDevServer = createPullRequestDevServerConnectorRoutes({
    recordUse: recordCompatibilityUse
  });
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

    if (request.method === 'GET' && url.pathname === '/api/app/releases') {
      try {
        const meta = await backend.getAppMeta();
        writeJson(response, 200, await releaseChangelogForVersion(meta.version));
      } catch {
        writeJson(response, 503, { error: 'Release changelog is temporarily unavailable.' });
      }
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/app/changelog') {
      const meta = await backend.getAppMeta();
      if (meta.preview?.state !== 'verified') {
        writeJson(response, 409, { error: 'Exact pull request identity is unavailable.' });
        return true;
      }
      const identity = meta.preview.identity;
      const source = readExactPullRequestChangelogSource(
        exactSourceRoot,
        identity.pullRequestNumber
      );
      if (!source) {
        writeJson(response, 503, { error: 'Exact pull request changelog is unavailable.' });
        return true;
      }
      writeJson(response, 200, {
        identity,
        source
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
      await Promise.allSettled(([
        'connector.project-registry.http.v1',
        ...(meaningfulNetworkEvidence(payload.connector.network)
          ? ['connector.private-network.http.v1'] as const
          : []),
        ...(payload.connector.battery || payload.connector.compute?.resources
          ? ['connector.resource-report.http.v1'] as const
          : [])
      ] as const).map((surface) =>
        recordCompatibilityUse(identity.userId, surface)
      ));
      return true;
    }

    return false;
  };
}
