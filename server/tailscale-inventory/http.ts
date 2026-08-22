import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  tailscaleDeviceClassifications,
  type TailscaleDeviceClassification,
  type TailscaleHostAssignmentRequest
} from '../../src/shared/tailscale-inventory-api';
import { writeJson } from '../project-space-http-response';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import {
  TailscaleClassificationRevisionConflict,
  TailscaleHostAssignmentRevisionConflict,
  TailscaleInventoryServiceError
} from './service';

const devicesRoute = '/api/compute/tailscale/devices';
const connectionRoute = '/api/compute/tailscale/connection';
const bodyLimit = 16 * 1024;
const identifier = /^[A-Za-z0-9._:-]{1,256}$/;

export function createTailscaleInventoryHttpApi(
  service: {
    list(ownerUserId: string, refresh?: boolean): Promise<unknown>;
    setClassification(actor: { actorId: string; kind: 'human' | 'machine'; ownerUserId: string }, deviceId: string, request: {
      classification: TailscaleDeviceClassification; expectedRevision: number;
    }): Promise<unknown>;
    setHostAssignment(
      actor: { actorId: string; kind: 'human' | 'machine'; ownerUserId: string },
      deviceId: string,
      request: TailscaleHostAssignmentRequest
    ): Promise<unknown>;
    getConnection?(ownerUserId: string): Promise<unknown>;
  },
  resolveActor: (request: IncomingMessage) => Promise<{ actorId: string; kind: 'human' | 'machine'; ownerUserId: string }>
) {
  return async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
    if (url.pathname !== connectionRoute && url.pathname !== devicesRoute &&
      !url.pathname.startsWith(`${devicesRoute}/`)) {
      return false;
    }
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const classificationDevice = classificationDeviceId(url.pathname);
      const hostDevice = hostDeviceId(url.pathname);
      if (url.pathname !== connectionRoute && url.pathname !== devicesRoute &&
        !classificationDevice && !hostDevice) {
        writeJson(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
        return true;
      }
      const actor = await resolveActor(request);
      if (actor.kind === 'machine') {
        throw new TailscaleInventoryServiceError(
          'machine-forbidden',
          'Only a person may access Tailscale inventory.'
        );
      }
      if (url.pathname === connectionRoute) {
        if ([...url.searchParams.keys()].length > 0) {
          throw new HttpInputError('The Tailscale provider connection request is invalid.');
        }
        if (request.method === 'GET' && service.getConnection) {
          writeJson(response, 200, await service.getConnection(actor.ownerUserId));
        } else {
          writeJson(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
        }
      } else if (url.pathname === devicesRoute && request.method === 'GET') {
        writeJson(response, 200, await service.list(actor.ownerUserId, parseRefresh(url)));
      } else if (classificationDevice && request.method === 'POST') {
        if ([...url.searchParams.keys()].length > 0) {
          throw new HttpInputError('The Tailscale classification request is invalid.');
        }
        writeJson(response, 200, await service.setClassification(
          actor,
          classificationDevice,
          parseClassification(await readBody(request))
        ));
      } else if (hostDevice && request.method === 'POST') {
        if ([...url.searchParams.keys()].length > 0) {
          throw new HttpInputError('The Tailnet device Host assignment request is invalid.');
        }
        writeJson(response, 200, await service.setHostAssignment(
          actor,
          hostDevice,
          parseHostAssignment(await readBody(request))
        ));
      } else {
        writeJson(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      }
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: 'Authentication failed.' }
        });
      } else if (error instanceof TailscaleClassificationRevisionConflict ||
        error instanceof TailscaleHostAssignmentRevisionConflict) {
        writeJson(response, 409, { error: { code: 'revision_conflict', message: error.message } });
      } else if (error instanceof TailscaleInventoryServiceError) {
        writeJson(response, ['unknown-device', 'unknown-host'].includes(error.code) ? 404 :
          error.code === 'connection-unavailable' ? 409 : 403, {
          error: { code: error.code.replaceAll('-', '_'), message: error.message }
        });
      } else if (error instanceof HttpInputError) {
        writeJson(response, 400, { error: { code: 'invalid_request', message: error.message } });
      } else {
        writeJson(response, 503, { error: { code: 'tailscale_inventory_unavailable', message: 'Tailscale inventory is temporarily unavailable.' } });
      }
    }
    return true;
  };
}

function classificationDeviceId(pathname: string) {
  const prefix = `${devicesRoute}/`; const suffix = '/classification';
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encodedId = pathname.slice(prefix.length, -suffix.length);
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    throw new HttpInputError('The Tailscale device id is invalid.');
  }
  if (!identifier.test(id) || id.includes('/')) throw new HttpInputError('The Tailscale device id is invalid.');
  return id;
}
function hostDeviceId(pathname: string) {
  return deviceIdForSuffix(pathname, '/host');
}
function deviceIdForSuffix(pathname: string, suffix: string) {
  const prefix = `${devicesRoute}/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const encodedId = pathname.slice(prefix.length, -suffix.length);
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    throw new HttpInputError('The Tailscale device id is invalid.');
  }
  if (!identifier.test(id) || id.includes('/')) throw new HttpInputError('The Tailscale device id is invalid.');
  return id;
}
function parseRefresh(url: URL) {
  if ([...url.searchParams.keys()].some((key) => key !== 'refresh') || url.searchParams.getAll('refresh').length > 1) {
    throw new HttpInputError('The Tailscale refresh request is invalid.');
  }
  const value = url.searchParams.get('refresh');
  if (value === null) return false;
  if (value !== '1') throw new HttpInputError('The Tailscale refresh request is invalid.');
  return true;
}
async function readBody(request: IncomingMessage) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpInputError('Content-Type must be application/json.');
  }
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += buffer.length;
    if (length > bodyLimit) throw new HttpInputError('Request body is too large.');
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpInputError('Request body must be a JSON object.'); }
}
function parseClassification(body: Record<string, unknown>) {
  if (Object.keys(body).length !== 2 || !('classification' in body) || !('expectedRevision' in body) ||
    !tailscaleDeviceClassifications.includes(body.classification as TailscaleDeviceClassification) ||
    !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0) {
    throw new HttpInputError('The Tailscale classification request is invalid.');
  }
  return { classification: body.classification as TailscaleDeviceClassification, expectedRevision: Number(body.expectedRevision) };
}
function parseHostAssignment(body: Record<string, unknown>): TailscaleHostAssignmentRequest {
  const expectedRevision = body.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0 ||
    typeof body.action !== 'string') {
    throw new HttpInputError('The Tailnet device Host assignment request is invalid.');
  }
  if (body.action === 'assign' && Object.keys(body).length === 3 &&
    typeof body.hostId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.hostId)) {
    return { action: 'assign', expectedRevision: Number(expectedRevision), hostId: body.hostId };
  }
  if (body.action === 'create' && Object.keys(body).length === 3 && typeof body.name === 'string') {
    const name = body.name.trim();
    if (name && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name)) {
      return { action: 'create', expectedRevision: Number(expectedRevision), name };
    }
  }
  if (body.action === 'unassign' && Object.keys(body).length === 2) {
    return { action: 'unassign', expectedRevision: Number(expectedRevision) };
  }
  throw new HttpInputError('The Tailnet device Host assignment request is invalid.');
}
class HttpInputError extends Error {}
