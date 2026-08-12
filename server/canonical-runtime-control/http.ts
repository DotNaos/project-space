import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CanonicalRuntimeControlRequest } from '../../src/shared/canonical-runtime-control-api';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';
import type { CanonicalRuntimeControlActor } from './contracts';
import { CanonicalRuntimeControlError } from './contracts';

export const canonicalRuntimeControlPath = '/api/runtime-control/v1/operations';
const maximumBodyBytes = 16 * 1024;

export function createCanonicalRuntimeControlHttpApi(
  service: {
    execute(
      actor: CanonicalRuntimeControlActor,
      request: CanonicalRuntimeControlRequest
    ): Promise<unknown>;
  },
  resolveActor: (request: IncomingMessage) => Promise<CanonicalRuntimeControlActor>
) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== canonicalRuntimeControlPath) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (request.method !== 'POST' || url.search) {
        writeJson(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
        return true;
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        invalid('Content-Type must be application/json.');
      }
      const contentLength = Number(request.headers['content-length'] ?? 0);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 ||
          contentLength > maximumBodyBytes) {
        invalid('Request body is too large.');
      }
      const actor = await resolveActor(request);
      const body = await readBody(request) as CanonicalRuntimeControlRequest;
      if (request.headers['idempotency-key'] !== body.operationId) {
        invalid('Idempotency-Key must match operationId.');
      }
      writeJson(response, 200, await service.execute(actor, body));
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: 'Runtime control authentication failed.' }
        });
      } else if (error instanceof CanonicalRuntimeControlError) {
        const status = error.code === 'authorization_denied' ? 403
          : error.code === 'invalid_request' ? 400
            : error.code === 'operation_conflict' || error.code === 'operation_in_progress'
              ? 409 : 503;
        writeJson(response, status, { error: { code: error.code, message: error.message } });
      } else {
        writeJson(response, 503, {
          error: { code: 'target_unavailable', message: 'Canonical Runtime control is unavailable.' }
        });
      }
    }
    return true;
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBodyBytes) invalid('Request body is too large.');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    invalid('Request body must be a JSON object.');
  }
}

function invalid(message: string): never {
  throw new CanonicalRuntimeControlError('invalid_request', message);
}
