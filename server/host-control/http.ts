import type { IncomingMessage, ServerResponse } from 'node:http';

import type { HostControlOperationRequest } from '../../src/shared/host-control-api';
import { writeJson } from '../project-space-http-response';
import { HostControlError, type HostControlActor } from './contracts';

const route = /^\/api\/compute\/hosts\/([^/]+)\/(status|console\/screenshot|operations)$/;
const maximumBodyBytes = 16 * 1024;

export function createHostControlHttpApi(
  service: {
    operate(actor: HostControlActor, selector: string, request: HostControlOperationRequest): Promise<unknown>;
    screenshot(actor: HostControlActor, selector: string): Promise<{
      capturedAt: string; frameId: string; height: number; png: Uint8Array; staleAfter: string; width: number;
    }>;
    status(actor: HostControlActor, selector: string): Promise<unknown>;
  },
  resolveActor: (request: IncomingMessage) => Promise<HostControlActor>
) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const match = route.exec(url.pathname);
    if (!match) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const actor = await resolveActor(request);
      let selector: string;
      try {
        selector = decodeURIComponent(match[1]!);
      } catch {
        throw new HostControlError('invalid_request', 'Host selector encoding is invalid.');
      }
      if (match[2] === 'status' && request.method === 'GET') {
        writeJson(response, 200, await service.status(actor, selector));
      } else if (match[2] === 'console/screenshot' && request.method === 'GET') {
        const frame = await service.screenshot(actor, selector);
        response.writeHead(200, {
          'Content-Type': 'image/png',
          'X-Project-Frame-Captured-At': frame.capturedAt,
          'X-Project-Frame-Height': String(frame.height),
          'X-Project-Frame-Id': frame.frameId,
          'X-Project-Frame-Stale-After': frame.staleAfter,
          'X-Project-Frame-Width': String(frame.width)
        });
        response.end(frame.png);
      } else if (match[2] === 'operations' && request.method === 'POST') {
        if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          throw new HostControlError('invalid_request', 'Content-Type must be application/json.');
        }
        const body = await readBody(request) as HostControlOperationRequest;
        if (request.headers['idempotency-key'] !== body.operationId) {
          throw new HostControlError('invalid_request', 'Idempotency-Key must match operationId.');
        }
        writeJson(response, 200, await service.operate(actor, selector, body));
      } else {
        writeJson(response, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
      }
    } catch (error) {
      if (error instanceof HostControlError) {
        const status = error.code === 'unauthorized' ? 403
          : error.code === 'invalid_request' ? 400
            : error.code === 'rate_limited' ? 429
              : error.code === 'provider_unavailable' ? 503 : 409;
        writeJson(response, status, { error: { code: error.code, message: error.message } });
      } else {
        writeJson(response, 503, {
          error: { code: 'provider_unavailable', message: 'Host control is temporarily unavailable.' }
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
    if (length > maximumBodyBytes) throw new HostControlError('invalid_request', 'Request body is too large.');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HostControlError('invalid_request', 'Request body must be a JSON object.');
  }
}
