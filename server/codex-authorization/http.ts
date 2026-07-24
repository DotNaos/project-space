import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CodexAuthorizationRequest } from '../../src/shared/codex-authorization-api';
import { CODEX_OPERATION_ID_PATTERN } from '../../src/shared/codex-sessions-api';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';
import { CodexAuthorizationServiceError } from './service';

const route = '/api/codex/authorization';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const maximumBodyBytes = 16 * 1024;

export function createCodexAuthorizationHttpApi(
  service: {
    authorize(
      actor: { userId: string },
      request: CodexAuthorizationRequest
    ): Promise<unknown>;
  },
  resolveActor: (request: IncomingMessage) => Promise<{ userId: string }>
) {
  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (request.method !== 'POST') {
        writeJson(response, 405, {
          error: { code: 'method_not_allowed', message: 'Method not allowed.' }
        });
        return true;
      }
      const actor = await resolveActor(request);
      const parsed = authorizationRequest(await readBody(request));
      if (request.headers['idempotency-key'] !== parsed.operationId) {
        throw invalid('Idempotency-Key must match operationId.');
      }
      writeJson(response, 200, await service.authorize(actor, parsed));
      return true;
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: error.message }
        });
      } else if (error instanceof CodexAuthorizationServiceError) {
        writeJson(response, error.code === 'unauthorized' ? 403 : 400, {
          error: { code: error.code.replaceAll('-', '_'), message: error.message }
        });
      } else {
        writeJson(response, 503, {
          error: {
            code: 'codex_authorization_unavailable',
            message: 'Codex authorization is temporarily unavailable.'
          }
        });
      }
      return true;
    }
  };
}

function authorizationRequest(body: Record<string, unknown>): CodexAuthorizationRequest {
  const allowed = new Set([
    'action', 'connectorId', 'operationId', 'physicalMachineId', 'physicalMachineName'
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw invalid('The Codex authorization request is invalid.');
  }
  const request = {
    action: body.action,
    connectorId: optionalIdentifier(body.connectorId),
    operationId: body.operationId,
    physicalMachineId: optionalIdentifier(body.physicalMachineId),
    physicalMachineName: optionalName(body.physicalMachineName)
  };
  if (
    typeof request.action !== 'string' ||
    !['cancel', 'start', 'status'].includes(request.action) ||
    typeof request.operationId !== 'string' ||
    !CODEX_OPERATION_ID_PATTERN.test(request.operationId) ||
    Number(Boolean(request.physicalMachineId)) +
      Number(Boolean(request.physicalMachineName)) !== 1
  ) {
    throw invalid('The Codex authorization request is invalid.');
  }
  return request as CodexAuthorizationRequest;
}

function optionalIdentifier(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !identifier.test(value)) {
    throw invalid('The Codex authorization selector is invalid.');
  }
  return value;
}

function optionalName(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid('The Codex authorization selector is invalid.');
  const name = value.trim();
  if (!name || name !== value || name.length > 80) {
    throw invalid('The Codex authorization selector is invalid.');
  }
  return name;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBodyBytes) throw invalid('Request body is too large.');
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw invalid('Request body must be a JSON object.');
  }
}

function invalid(message: string) {
  return new CodexAuthorizationServiceError('invalid-request', message);
}
