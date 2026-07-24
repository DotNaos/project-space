import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  MachineReadinessFixRequest,
  MachineReadinessSelector
} from '../../src/shared/machine-readiness-api';
import { CODEX_OPERATION_ID_PATTERN } from '../../src/shared/codex-sessions-api';
import { writeJson } from '../project-space-http-response';
import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { MachineReadinessServiceError } from './service';

const route = '/api/machine-readiness';
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const planId = /^[a-f0-9]{64}$/;
const maximumBodyBytes = 16 * 1024;

export interface MachineReadinessHttpService {
  diagnose(
    actor: { userId: string },
    selector: MachineReadinessSelector
  ): Promise<unknown>;
  fix(
    actor: { userId: string },
    request: MachineReadinessFixRequest
  ): Promise<unknown>;
}

export function createMachineReadinessHttpApi(
  service: MachineReadinessHttpService,
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
      const actor = await resolveActor(request);
      if (request.method === 'GET') {
        writeJson(response, 200, await service.diagnose(actor, selectorFromUrl(url)));
        return true;
      }
      if (request.method === 'POST') {
        const body = await readBody(request);
        const parsed = fixRequest(body);
        if (request.headers['idempotency-key'] !== parsed.operationId) {
          throw invalid('Idempotency-Key must match operationId.');
        }
        writeJson(response, 202, await service.fix(actor, parsed));
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
      } else if (error instanceof MachineReadinessServiceError) {
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
            code: 'machine_readiness_unavailable',
            message: 'Machine readiness is temporarily unavailable.'
          }
        });
      }
      return true;
    }
  };
}

function selectorFromUrl(url: URL): MachineReadinessSelector {
  const selector = {
    connectorId: optionalIdentifier(url.searchParams.get('connectorId')),
    physicalMachineId: optionalIdentifier(url.searchParams.get('physicalMachineId')),
    physicalMachineName: optionalName(url.searchParams.get('physicalMachineName'))
  };
  validateSelector(selector);
  const allowed = new Set(['connectorId', 'physicalMachineId', 'physicalMachineName']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw invalid('The readiness selector is invalid.');
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      throw invalid('The readiness selector is invalid.');
    }
  }
  return selector;
}

function fixRequest(body: Record<string, unknown>): MachineReadinessFixRequest {
  const allowed = new Set([
    'connectorId', 'operationId', 'physicalMachineId', 'physicalMachineName', 'planId'
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw invalid('The readiness repair request is invalid.');
  }
  const selector = {
    connectorId: optionalIdentifier(body.connectorId),
    physicalMachineId: optionalIdentifier(body.physicalMachineId),
    physicalMachineName: optionalName(body.physicalMachineName)
  };
  validateSelector(selector);
  if (typeof body.operationId !== 'string' ||
      !CODEX_OPERATION_ID_PATTERN.test(body.operationId) ||
      typeof body.planId !== 'string' || !planId.test(body.planId)) {
    throw invalid('The readiness repair request is invalid.');
  }
  return { ...selector, operationId: body.operationId, planId: body.planId };
}

function validateSelector(selector: MachineReadinessSelector) {
  const selected = Number(Boolean(selector.physicalMachineId)) +
    Number(Boolean(selector.physicalMachineName));
  if (selected !== 1) {
    throw invalid('Select one exact physical machine by name or ID.');
  }
}

function optionalIdentifier(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !identifier.test(value)) {
    throw invalid('The readiness selector is invalid.');
  }
  return value;
}

function optionalName(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw invalid('The readiness selector is invalid.');
  const name = value.trim();
  if (!name || name !== value || name.length > 80) {
    throw invalid('The readiness selector is invalid.');
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
  return new MachineReadinessServiceError('invalid-request', message);
}
