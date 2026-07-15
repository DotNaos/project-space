import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ProjectSpaceBackend } from '../src/shared/project-space-api';
import {
  parseConnectorRuntimeMaintenanceBrowserRequest
} from './connector-runtime-maintenance-contract';
import { ConnectorRuntimeMaintenanceServiceError } from './connector-runtime-maintenance-service';
import {
  ConnectorRuntimeStopServiceError,
  parseConnectorRuntimeStopBrowserRequest
} from './connector-runtime-stop-service';
import { ConnectorRuntimeReleaseManifestError } from './connector-runtime-release-manifest';
import { ConnectorRuntimeReleaseSourceError } from './connector-runtime-release-source';
import { readJson, writeJson } from './project-space-http-response';

const runtimePath = /^\/api\/machines\/([^/]+)\/runtime(?:\/(operations|stop))?$/;
const machineIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function statusFor(error: unknown) {
  if (error instanceof ConnectorRuntimeStopServiceError) {
    if (error.code === 'invalid-request') return 400;
    if (error.code === 'invalid-actor') return 401;
    if (error.code === 'unauthorized') return 403;
    if (error.code === 'unknown-machine') return 404;
    return 409;
  }
  if (error instanceof ConnectorRuntimeMaintenanceServiceError) {
    if (error.code === 'unauthorized') return 403;
    if (error.code === 'unknown-machine') return 404;
    if (error.code === 'rate-limited') return 429;
    if (error.code === 'invalid-actor') return 401;
    return 409;
  }
  if (error instanceof ConnectorRuntimeReleaseManifestError ||
      error instanceof ConnectorRuntimeReleaseSourceError) return 409;
  if (error && typeof error === 'object' && 'code' in error &&
      error.code === 'invalid-request') return 400;
  return undefined;
}

export function createConnectorRuntimeHttpHandler(backend: ProjectSpaceBackend) {
  return async function handleConnectorRuntimeRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    const match = runtimePath.exec(url.pathname);
    if (!match?.[1]) return false;
    let machineId = '';
    try {
      machineId = decodeURIComponent(match[1]);
    } catch {
      writeJson(response, 400, { error: 'The machine ID is invalid.' });
      return true;
    }
    if (!machineIdPattern.test(machineId)) {
      writeJson(response, 400, { error: 'The machine ID is invalid.' });
      return true;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (request.method === 'GET' && !match[2]) {
        writeJson(response, 200, await backend.getMachineRuntime(machineId));
        return true;
      }
      if (request.method === 'POST' && match[2] === 'operations') {
        const body = await readJson<unknown>(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).some((key) => key !== 'operation' && key !== 'releaseId')) {
          parseConnectorRuntimeMaintenanceBrowserRequest({ machineId, invalid: true });
        }
        const parsed = parseConnectorRuntimeMaintenanceBrowserRequest({
          ...(body as Record<string, unknown>),
          machineId
        });
        writeJson(response, 202, await backend.startMachineRuntimeOperation(machineId, {
          operation: parsed.operation,
          ...(parsed.releaseId ? { releaseId: parsed.releaseId } : {})
        }));
        return true;
      }
      if (request.method === 'POST' && match[2] === 'stop') {
        const body = await readJson<unknown>(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            Object.keys(body).length !== 0) {
          parseConnectorRuntimeStopBrowserRequest({ machineId, invalid: true });
        }
        parseConnectorRuntimeStopBrowserRequest({ machineId });
        writeJson(response, 202, await backend.stopMachineRuntime(machineId));
        return true;
      }
      writeJson(response, 405, { error: 'Method not allowed.' });
      return true;
    } catch (error) {
      const status = statusFor(error);
      if (status === undefined) throw error;
      if (error instanceof ConnectorRuntimeMaintenanceServiceError && error.retryAfterMs) {
        response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1_000)));
      }
      writeJson(response, status, {
        error: error instanceof Error ? error.message : 'The runtime request failed.'
      });
      return true;
    }
  };
}
