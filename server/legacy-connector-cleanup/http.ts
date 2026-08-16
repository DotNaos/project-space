import type { IncomingMessage, ServerResponse } from 'node:http';

import type { LegacyConnectorRemovalTarget } from '../../src/shared/legacy-connector-cleanup-api';
import { writeJson } from '../project-space-http-response';
import type { LegacyConnectorCleanupService } from './service';

export const legacyConnectorCleanupListPath = '/api/compute/legacy-connectors';
export const legacyConnectorCleanupRemovalPath =
  '/api/compute/legacy-connectors/removals';

const maximumBodyBytes = 16 * 1024;
const maximumRecords = 100;
const connectorIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface LegacyConnectorCleanupActor {
  actorId: string;
  kind: 'human' | 'machine';
  ownerUserId: string;
}

export function createLegacyConnectorCleanupHttpApi(
  service: LegacyConnectorCleanupService,
  resolveActor: (request: IncomingMessage) => Promise<LegacyConnectorCleanupActor>
) {
  return async function handleLegacyConnectorCleanup(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== legacyConnectorCleanupListPath &&
        url.pathname !== legacyConnectorCleanupRemovalPath) {
      return false;
    }

    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (url.search) {
        invalid('Query parameters are not allowed.');
      }

      const isList = url.pathname === legacyConnectorCleanupListPath;
      if (isList && request.method !== 'GET') {
        methodNotAllowed(response);
        return true;
      }
      if (!isList && request.method !== 'POST') {
        methodNotAllowed(response);
        return true;
      }
      if (isList && hasRequestBody(request)) {
        invalid('A legacy Connector inventory request must not include a body.');
      }

      const actor = await resolveActor(request);
      if (actor.kind !== 'human') {
        writeJson(response, 403, {
          error: { code: 'human_session_required', message: 'A human session is required.' }
        });
        return true;
      }

      if (isList) {
        writeJson(response, 200, await service.list(actor.ownerUserId));
        return true;
      }

      const requestId = readIdempotencyKey(request);
      const records = parseRemovalRecords(await readJsonBody(request));
      writeJson(response, 200, await service.remove(actor.ownerUserId, {
        actorId: actor.actorId,
        records,
        requestId
      }));
    } catch (error) {
      if (error instanceof LegacyConnectorCleanupHttpError) {
        writeJson(response, 400, {
          error: { code: 'invalid_request', message: error.message }
        });
      } else if (isAuthenticationError(error)) {
        writeJson(response, error.statusCode, {
          error: {
            code: error.statusCode === 401 ? 'authentication_required' : 'access_denied',
            message: error.statusCode === 401 ? 'Authentication is required.' : 'Access is denied.'
          }
        });
      } else if (isConflictError(error)) {
        writeJson(response, 409, {
          error: { code: 'removal_conflict', message: 'The legacy Connector cleanup conflicts with current state.' }
        });
      } else {
        writeJson(response, 503, {
          error: {
            code: 'legacy_connector_cleanup_unavailable',
            message: 'Legacy Connector cleanup is temporarily unavailable.'
          }
        });
      }
    }
    return true;
  };
}

function methodNotAllowed(response: ServerResponse) {
  writeJson(response, 405, {
    error: { code: 'method_not_allowed', message: 'Method not allowed.' }
  });
}

function hasRequestBody(request: IncomingMessage) {
  const contentLength = request.headers['content-length'];
  if (Array.isArray(contentLength) ||
      (typeof contentLength === 'string' && contentLength !== '0')) {
    return true;
  }
  return request.headers['transfer-encoding'] !== undefined;
}

function readIdempotencyKey(request: IncomingMessage) {
  const values = rawHeaderValues(request, 'idempotency-key');
  if (values.length !== 1 || !idempotencyKeyPattern.test(values[0]!)) {
    invalid('Idempotency-Key is required and invalid keys are not accepted.');
  }
  return values[0]!;
}

function rawHeaderValues(request: IncomingMessage, name: string) {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1] ?? '');
    }
  }
  if (values.length > 0) return values;
  const header = request.headers[name];
  return Array.isArray(header) ? header : header === undefined ? [] : [header];
}

async function readJsonBody(request: IncomingMessage) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
    invalid('Content-Type must be application/json.');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBodyBytes) invalid('Request body is too large.');
    chunks.push(buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    invalid('Request body must be a JSON object.');
  }
}

function parseRemovalRecords(body: Record<string, unknown>): LegacyConnectorRemovalTarget[] {
  if (Object.keys(body).length !== 1 || !Array.isArray(body.records) ||
      body.records.length === 0 || body.records.length > maximumRecords) {
    invalid('The legacy Connector removal request is invalid.');
  }
  const connectorIds = new Set<string>();
  return body.records.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalid('The legacy Connector removal request is invalid.');
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 ||
        !connectorIdPattern.test(String(record.connectorId ?? '')) ||
        !fingerprintPattern.test(String(record.fingerprint ?? '')) ||
        connectorIds.has(record.connectorId as string)) {
      invalid('The legacy Connector removal request is invalid.');
    }
    connectorIds.add(record.connectorId as string);
    return { connectorId: record.connectorId as string, fingerprint: record.fingerprint as string };
  });
}

function isAuthenticationError(error: unknown): error is { statusCode: 401 | 403 } {
  return Boolean(error && typeof error === 'object' &&
    ((error as { statusCode?: unknown }).statusCode === 401 ||
      (error as { statusCode?: unknown }).statusCode === 403));
}

function isConflictError(error: unknown) {
  return Boolean(error && typeof error === 'object' &&
    (error as { code?: unknown }).code === 'conflict');
}

class LegacyConnectorCleanupHttpError extends Error {}

function invalid(message: string): never {
  throw new LegacyConnectorCleanupHttpError(message);
}
