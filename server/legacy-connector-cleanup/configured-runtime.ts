import type { IncomingMessage, ServerResponse } from 'node:http';

import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import {
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured
} from '../local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest
} from '../local-auth-store';
import { writeJson } from '../project-space-http-response';
import {
  createLegacyConnectorCleanupHttpApi,
  legacyConnectorCleanupListPath,
  legacyConnectorCleanupRemovalPath,
  type LegacyConnectorCleanupActor
} from './http';
import { createLegacyConnectorCleanupService } from './service';
import { PostgresLegacyConnectorCleanupStore } from './store';

export function createConfiguredLegacyConnectorCleanupHandler() {
  let runtime: Promise<ReturnType<typeof createLegacyConnectorCleanupHttpApi>> | undefined;

  return async function handleConfiguredLegacyConnectorCleanup(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== legacyConnectorCleanupListPath &&
        url.pathname !== legacyConnectorCleanupRemovalPath) {
      return false;
    }
    if (!isDatabaseConfigured()) return unavailable(response);

    try {
      runtime ??= getMachineConnectionDatabaseClient().then((database) => (
        createLegacyConnectorCleanupHttpApi(
          createLegacyConnectorCleanupService({
            store: new PostgresLegacyConnectorCleanupStore(database)
          }),
          resolveHumanActor
        )
      ));
      return await (await runtime)(request, response, url);
    } catch {
      runtime = undefined;
      return unavailable(response);
    }
  };
}

async function resolveHumanActor(request: IncomingMessage): Promise<LegacyConnectorCleanupActor> {
  if (hasMachineIdentityHeader(request)) {
    return { actorId: 'machine', kind: 'machine', ownerUserId: 'machine' };
  }
  if (!isProjectSpaceAuthRequired()) {
    return {
      actorId: 'local-development-user',
      kind: 'human',
      ownerUserId: 'local-development-user'
    };
  }
  const session = await readAuthSessionFromRequest(request);
  if (!session) throw new CodexMachineTasksAuthError(401);
  return { actorId: session.userId, kind: 'human', ownerUserId: session.userId };
}

function hasMachineIdentityHeader(request: IncomingMessage) {
  return request.rawHeaders.some((value, index) =>
    index % 2 === 0 && value.toLowerCase() === 'x-project-machine-id'
  );
}

function unavailable(response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store');
  writeJson(response, 503, {
    error: {
      code: 'legacy_connector_cleanup_unavailable',
      message: 'Legacy Connector cleanup is temporarily unavailable.'
    }
  });
  return true;
}
