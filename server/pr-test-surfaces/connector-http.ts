import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  PullRequestDevServerHeartbeatRequest,
  PullRequestDevServerRegistrationRequest,
  PullRequestDevServerReleaseRequest
} from '../../src/shared/pr-preview-test-surfaces-api';
import {
  requestConnectorToken,
  resolveConnectorMachineTokenIdentity
} from '../connector-registration-auth';
import { readJson, writeJson } from '../project-space-http-response';
import {
  heartbeatConfiguredPullRequestDevServer,
  registerConfiguredPullRequestDevServer,
  releaseConfiguredPullRequestDevServer
} from './configured-runtime';
import { PullRequestDevServerLeaseError } from './lease-service';

const prefix = '/api/pull-request-previews/dev-server/';

export function createPullRequestDevServerConnectorRoutes(options: {
  heartbeat?: typeof heartbeatConfiguredPullRequestDevServer;
  register?: typeof registerConfiguredPullRequestDevServer;
  release?: typeof releaseConfiguredPullRequestDevServer;
  resolveIdentity?: typeof resolveConnectorMachineTokenIdentity;
} = {}) {
  const heartbeat = options.heartbeat ?? heartbeatConfiguredPullRequestDevServer;
  const register = options.register ?? registerConfiguredPullRequestDevServer;
  const release = options.release ?? releaseConfiguredPullRequestDevServer;
  const resolveIdentity = options.resolveIdentity ?? resolveConnectorMachineTokenIdentity;
  return async function handlePullRequestDevServerConnectorRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (request.method !== 'POST' || !url.pathname.startsWith(prefix)) return false;
    const operation = url.pathname.slice(prefix.length);
    if (!['register', 'heartbeat', 'release'].includes(operation)) return false;
    const payload = await readJson<Record<string, unknown>>(request);
    const connectorId = typeof payload.connectorId === 'string'
      ? payload.connectorId
      : '';
    const machineId = typeof payload.machineId === 'string' ? payload.machineId : '';
    const identity = await resolveIdentity(
      requestConnectorToken(request),
      connectorId
    );
    if (!identity || identity.machineId !== connectorId || !identity.userId) {
      writeJson(response, 401, { error: 'A claimed connector credential is required.' });
      return true;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const actor = {
        connectorId,
        machineId,
        userId: identity.userId
      };
      const result = operation === 'register'
        ? await register(
            actor,
            payload as unknown as PullRequestDevServerRegistrationRequest
          )
        : operation === 'heartbeat'
          ? await heartbeat(
              actor,
              payload as unknown as PullRequestDevServerHeartbeatRequest
            )
          : await release(
              actor,
              payload as unknown as PullRequestDevServerReleaseRequest
            );
      writeJson(response, 200, result);
    } catch (error) {
      if (!(error instanceof PullRequestDevServerLeaseError)) throw error;
      const status = error.code === 'forbidden'
        ? 403
        : ['heartbeat-expired', 'lease-revoked', 'lease-superseded']
            .includes(error.code)
          ? 409
          : 400;
      writeJson(response, status, { error: error.code });
    }
    return true;
  };
}
