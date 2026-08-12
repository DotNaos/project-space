import type { IncomingMessage, ServerResponse } from 'node:http';

import { CodexMachineTasksAuthError } from '../codex-machine-tasks/auth-context';
import { writeJson } from '../project-space-http-response';
import type {
  SshGatewayActor,
  SshGatewayExecutionResult,
  SshGatewayRequest
} from './contracts';
import { SshGatewayError } from './contracts';

const route = '/api/compute/control/status';
const maximumBodyBytes = 16 * 1024;

export interface SshControlHttpActor {
  callerMachineId?: string;
  userId: string;
}

export function createSshControlGatewayHttpApi(
  service: { execute(actor: SshGatewayActor, request: SshGatewayRequest): Promise<SshGatewayExecutionResult> },
  resolveActor: (request: IncomingMessage) => Promise<SshControlHttpActor>
) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname !== route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      if (request.method !== 'POST' || [...url.searchParams.keys()].length > 0) {
        throw invalid('SSH control status requires one POST request without query parameters.');
      }
      const actor = await resolveActor(request);
      if (!actor.callerMachineId) {
        throw new SshGatewayError('authorization_denied', 'Machine authentication is required.');
      }
      const input = statusRequest(await readBody(request));
      if (request.headers['idempotency-key'] !== input.operationId) {
        throw invalid('Idempotency-Key must match operationId.');
      }
      writeJson(response, 200, await service.execute({
        id: actor.callerMachineId,
        kind: 'machine',
        ownerUserId: actor.userId
      }, input));
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: 'Project Space machine authentication failed.' }
        });
      } else if (error instanceof SshGatewayError) {
        writeJson(response, statusFor(error.code), {
          error: { code: error.code, message: error.message }
        });
      } else {
        writeJson(response, 503, {
          error: { code: 'ssh_control_unavailable', message: 'SSH control is temporarily unavailable.' }
        });
      }
    }
    return true;
  };
}

function statusRequest(body: Record<string, unknown>): SshGatewayRequest {
  if (Object.keys(body).sort().join('\0') !== 'environmentId\0operationId' ||
    typeof body.environmentId !== 'string' || !isUuid(body.environmentId) ||
    typeof body.operationId !== 'string' ||
    !/^[A-Za-z0-9:._-]{1,256}$/.test(body.operationId)) {
    throw invalid('SSH control status request is invalid.');
  }
  return {
    environmentId: body.environmentId,
    operation: 'status.v1',
    operationId: body.operationId
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBodyBytes) throw invalid('SSH control request body is too large.');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SshGatewayError) throw error;
    throw invalid('SSH control request body must be a JSON object.');
  }
}

function statusFor(code: SshGatewayError['code']) {
  if (code === 'authorization_denied') return 403;
  if (code === 'operation_conflict' || code === 'operation_in_progress') return 409;
  if (code === 'timeout') return 504;
  return 503;
}

function invalid(message: string) {
  return new SshGatewayError('operation_conflict', message);
}
