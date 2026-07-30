import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  MachinePowerOperationResult,
  MachinePowerRequest,
  MachinePowerSelector,
  MachinePowerStatusResult
} from '../../src/shared/machine-power-api';
import { CODEX_OPERATION_ID_PATTERN } from '../../src/shared/codex-sessions-api';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';
import { MachinePowerServiceError } from './service';
import type { MachinePowerActor } from './service';

const route = '/api/machine-power';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const maximumBodyBytes = 16 * 1024;

export interface MachinePowerHttpService {
  request(
    actor: MachinePowerActor,
    input: MachinePowerRequest
  ): Promise<MachinePowerOperationResult>;
  status(
    actor: MachinePowerActor,
    selector: MachinePowerSelector
  ): Promise<MachinePowerStatusResult>;
}

export function createMachinePowerHttpApi(
  service: MachinePowerHttpService,
  resolveActor: (request: IncomingMessage) => Promise<MachinePowerActor>
) {
  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const actor = await resolveActor(request);
      if (request.method === 'GET') {
        writeJson(response, 200, await service.status(actor, selectorFromUrl(url)));
        return true;
      }
      if (request.method === 'POST') {
        const input = powerRequest(await readBody(request));
        if (request.headers['idempotency-key'] !== input.operationId) {
          throw invalid('Idempotency-Key must match operationId.');
        }
        const result = await service.request(actor, input);
        writeJson(response, result.state === 'accepted' ? 202 : 200, result);
        return true;
      }
      writeJson(response, 405, {
        error: { code: 'method_not_allowed', message: 'Method not allowed.' }
      });
      return true;
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: error.message }
        });
      } else if (error instanceof MachinePowerServiceError) {
        const status = error.code === 'unauthorized'
          ? 403
          : error.code === 'invalid-request'
            ? 400
            : 409;
        writeJson(response, status, {
          error: { code: error.code.replaceAll('-', '_'), message: error.message }
        });
      } else {
        writeJson(response, 503, {
          error: {
            code: 'machine_power_unavailable',
            message: 'Machine power control is temporarily unavailable.'
          }
        });
      }
      return true;
    }
  };
}

function selectorFromUrl(url: URL): MachinePowerSelector {
  const selector = {
    physicalMachineId: optionalIdentifier(url.searchParams.get('physicalMachineId')),
    physicalMachineName: optionalName(url.searchParams.get('physicalMachineName'))
  };
  validateSelector(selector);
  const allowed = new Set(['physicalMachineId', 'physicalMachineName']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length > 1) {
      throw invalid('The machine power selector is invalid.');
    }
  }
  return selector;
}

function powerRequest(body: Record<string, unknown>): MachinePowerRequest {
  const allowed = new Set([
    'operationId', 'physicalMachineId', 'physicalMachineName', 'requestedState'
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw invalid('The machine power request is invalid.');
  }
  const selector = {
    physicalMachineId: optionalIdentifier(body.physicalMachineId),
    physicalMachineName: optionalName(body.physicalMachineName)
  };
  validateSelector(selector);
  if (typeof body.operationId !== 'string' ||
      !CODEX_OPERATION_ID_PATTERN.test(body.operationId) ||
      (body.requestedState !== 'on' && body.requestedState !== 'off')) {
    throw invalid('The machine power request is invalid.');
  }
  return { ...selector, operationId: body.operationId, requestedState: body.requestedState };
}

function validateSelector(selector: MachinePowerSelector) {
  if (Number(Boolean(selector.physicalMachineId)) +
      Number(Boolean(selector.physicalMachineName)) !== 1) {
    throw invalid('Select one exact physical machine by name or ID.');
  }
}

function optionalIdentifier(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !identifier.test(value)) {
    throw invalid('The machine power selector is invalid.');
  }
  return value;
}

function optionalName(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim() !== value || !value || value.length > 80) {
    throw invalid('The machine power selector is invalid.');
  }
  return value;
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
  return new MachinePowerServiceError('invalid-request', message);
}
