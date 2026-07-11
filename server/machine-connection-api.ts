import type { IncomingMessage, ServerResponse } from 'node:http';

import type { MachineConnectMetadata } from './machine-connection-contract';
import {
  MachineConnectionError,
  type MachineConnectionService
} from './machine-connection-service';
import { projectSpaceCorsHeaders } from './project-space-http-response';

const maximumBodyBytes = 32 * 1024;

interface MachineConnectionApiOptions {
  allowCreateRequest(request: IncomingMessage): Promise<boolean>;
  readAuthenticatedUserId(request: IncomingMessage): Promise<string | null>;
  service: MachineConnectionService;
}

class RequestBodyError extends Error {}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    ...projectSpaceCorsHeaders(),
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage) {
  const declaredLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBodyBytes) {
    throw new RequestBodyError('Request body is too large.');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBodyBytes) {
      throw new RequestBodyError('Request body is too large.');
    }
    chunks.push(bytes);
  }

  try {
    const body = Buffer.concat(chunks).toString('utf8').trim();
    return body ? (JSON.parse(body) as unknown) : {};
  } catch {
    throw new RequestBodyError('Request body is not valid JSON.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bearerToken(request: IncomingMessage) {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function metadataFromBody(body: unknown): MachineConnectMetadata {
  const value = isRecord(body) ? body : {};
  return {
    architecture: stringValue(value.architecture) as MachineConnectMetadata['architecture'],
    clientVersion: stringValue(value.clientVersion),
    hostname: stringValue(value.hostname),
    name: stringValue(value.name),
    operatingSystem: stringValue(
      value.operatingSystem
    ) as MachineConnectMetadata['operatingSystem'],
    publicKey: stringValue(value.publicKey)
  };
}

function errorStatus(error: MachineConnectionError) {
  switch (error.code) {
    case 'invalid_input':
    case 'invalid_proof':
      return 400;
    case 'not_found':
      return 404;
    case 'invalid_credential':
      return 401;
    case 'revoked':
      return 403;
    case 'already_decided':
    case 'already_used':
    case 'denied':
    case 'expired':
    case 'pending':
      return 409;
  }
}

async function requireUser(
  request: IncomingMessage,
  response: ServerResponse,
  readAuthenticatedUserId: MachineConnectionApiOptions['readAuthenticatedUserId']
) {
  const userId = await readAuthenticatedUserId(request);
  if (!userId) {
    writeJson(response, 401, { error: 'Login required.' });
    return null;
  }
  return userId;
}

export function createMachineConnectionApiHandler(options: MachineConnectionApiOptions) {
  return async function handleMachineConnectionApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (request.method === 'POST' && url.pathname === '/api/machine-connections') {
      try {
        if (!(await options.allowCreateRequest(request))) {
          response.setHeader('Retry-After', '60');
          writeJson(response, 429, { error: 'Too many machine connection requests.' });
          return true;
        }
        writeJson(
          response,
          201,
          await options.service.createRequest(metadataFromBody(await readJson(request)))
        );
      } catch (error) {
        handleError(response, error);
      }
      return true;
    }

    const approvalMatch = url.pathname.match(
      /^\/api\/machine-connections\/([^/]+)\/approval$/
    );
    if (request.method === 'GET' && approvalMatch?.[1]) {
      const userId = await requireUser(
        request,
        response,
        options.readAuthenticatedUserId
      );
      if (!userId) return true;
      try {
        writeJson(response, 200, await options.service.getApprovalView(approvalMatch[1]));
      } catch (error) {
        handleError(response, error);
      }
      return true;
    }

    const decisionMatch = url.pathname.match(
      /^\/api\/machine-connections\/([^/]+)\/(approve|deny)$/
    );
    if (request.method === 'POST' && decisionMatch?.[1] && decisionMatch[2]) {
      const userId = await requireUser(
        request,
        response,
        options.readAuthenticatedUserId
      );
      if (!userId) return true;
      try {
        const result =
          decisionMatch[2] === 'approve'
            ? await options.service.approveRequest(decisionMatch[1], userId)
            : await options.service.denyRequest(decisionMatch[1], userId);
        writeJson(response, 200, result);
      } catch (error) {
        handleError(response, error);
      }
      return true;
    }

    const requestMatch = url.pathname.match(/^\/api\/machine-connections\/([^/]+)$/);
    if (request.method === 'GET' && requestMatch?.[1]) {
      try {
        writeJson(
          response,
          200,
          await options.service.pollRequest(requestMatch[1], bearerToken(request))
        );
      } catch (error) {
        handleError(response, error);
      }
      return true;
    }

    const exchangeMatch = url.pathname.match(
      /^\/api\/machine-connections\/([^/]+)\/exchange$/
    );
    if (request.method === 'POST' && exchangeMatch?.[1]) {
      try {
        const body = await readJson(request);
        const signature = isRecord(body) ? stringValue(body.signature) : '';
        writeJson(
          response,
          200,
          await options.service.exchangeApproval(
            exchangeMatch[1],
            bearerToken(request),
            signature
          )
        );
      } catch (error) {
        handleError(response, error);
      }
      return true;
    }

    const machineMatch = url.pathname.match(
      /^\/api\/machines\/([^/]+)\/(connection|revoke)$/
    );
    if (machineMatch?.[1] && machineMatch[2] === 'connection' && request.method === 'GET') {
      try {
        writeJson(
          response,
          200,
          await options.service.getConnectionStatus(machineMatch[1], bearerToken(request))
        );
      } catch (error) {
        handleError(response, error);
      }
      return true;
    }
    if (machineMatch?.[1] && machineMatch[2] === 'revoke' && request.method === 'POST') {
      try {
        writeJson(
          response,
          200,
          await options.service.revokeMachine(machineMatch[1], bearerToken(request))
        );
      } catch (error) {
        handleError(response, error);
      }
      return true;
    }

    return false;
  };
}

function handleError(response: ServerResponse, error: unknown) {
  if (error instanceof RequestBodyError) {
    writeJson(response, 400, { error: error.message });
    return;
  }
  if (error instanceof MachineConnectionError) {
    writeJson(response, errorStatus(error), { code: error.code, error: error.message });
    return;
  }
  writeJson(response, 500, { error: 'Machine connection request failed.' });
}
