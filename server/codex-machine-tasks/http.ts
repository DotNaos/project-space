import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  CodexMachineTaskReadRequest,
  CodexMachineTaskSendRequest,
  CodexMachineTaskStartRequest
} from '../../src/shared/codex-machine-tasks-api';
import { CODEX_MACHINE_TASKS_API_VERSION } from '../../src/shared/codex-machine-tasks-api';
import {
  CODEX_OPERATION_ID_PATTERN,
  CODEX_THREAD_ID_PATTERN
} from '../../src/shared/codex-sessions-api';
import { writeJson } from '../project-space-http-response';
import { CodexMachineTasksAuthError } from './auth-context';
import { codexAttachToken, CodexMachineTasksConflictError } from './service';

const maximumBodyBytes = 32 * 1024;
const safeSelector = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export interface CodexMachineTasksHttpService {
  attach(actor: { callerMachineId?: string; userId: string }, request: {
    connectorId?: string;
    operationId: string;
    physicalMachineId?: string;
    physicalMachineName?: string;
    threadId: string;
  }): Promise<unknown>;
  read(actor: { userId: string }, request: CodexMachineTaskReadRequest): Promise<unknown>;
  send(actor: { userId: string }, request: CodexMachineTaskSendRequest): Promise<unknown>;
  start(actor: { callerMachineId?: string; userId: string }, request: CodexMachineTaskStartRequest): Promise<unknown>;
  stream(
    actor: { userId: string },
    request: CodexMachineTaskReadRequest & { afterSequence?: number },
    emit: (event: unknown, sequence?: number) => void,
    signal: AbortSignal,
    onReady?: () => void
  ): Promise<void>;
}

export type CodexMachineTasksHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean>;

export function createCodexMachineTasksHttpApi(
  service: CodexMachineTasksHttpService,
  resolveActor: (request: IncomingMessage) => Promise<{
    callerMachineId?: string;
    userId: string;
  }>
): CodexMachineTasksHttpHandler {
  return async (request, response, url) => {
    const route = routeFor(request.method, url.pathname);
    if (!route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const actor = await resolveActor(request);
      if (route.kind === 'start') {
        const body = await readBody(request);
        const operationId = operation(body.operationId);
        requireIdempotency(request, operationId);
        const issue = Number(body.issue);
        if (!Number.isSafeInteger(issue) || issue < 1) throw invalid('Issue must be positive.');
        writeJson(response, 200, await service.start(actor, {
          connectorId: optionalSelector(body.connectorId),
          dryRun: body.dryRun === true,
          issue,
          operationId,
          physicalMachineId: optionalSelector(body.physicalMachineId),
          physicalMachineName: optionalSelector(body.physicalMachineName),
          repositoryId: optionalSelector(body.repositoryId)
        }));
        return true;
      }
      const mutationBody = route.kind === 'send' || route.kind === 'attach'
        ? await readBody(request)
        : undefined;
      const selector = mutationBody
        ? selectorFromBody(mutationBody, route.threadId)
        : selectorFromUrl(url, route.threadId);
      if (route.kind === 'read') {
        const last = url.searchParams.get('last');
        const parsedLast = last === null ? undefined : Number(last);
        if (parsedLast !== undefined && (!Number.isSafeInteger(parsedLast) || parsedLast < 1 || parsedLast > 1000)) {
          throw invalid('last must be between 1 and 1000.');
        }
        writeJson(response, 200, await service.read(actor, { ...selector, last: parsedLast }));
        return true;
      }
      if (route.kind === 'send') {
        const body = mutationBody!;
        const operationId = operation(body.operationId);
        requireIdempotency(request, operationId);
        if (typeof body.message !== 'string' || !body.message || body.message.length > 16_000) {
          throw invalid('Message is required and must be 16000 characters or fewer.');
        }
        writeJson(response, 200, await service.send(actor, {
          ...selector,
          message: body.message,
          operationId,
          wait: body.wait === true
        }));
        return true;
      }
      if (route.kind === 'attach') {
        const body = mutationBody!;
        const operationId = operation(body.operationId);
        requireIdempotency(request, operationId);
        const attached = await service.attach(actor, { ...selector, operationId });
        const token = attached && typeof attached === 'object'
          ? (attached as { [codexAttachToken]?: unknown })[codexAttachToken]
          : undefined;
        if (typeof token === 'string') {
          response.setHeader('X-Project-Codex-Attach-Token', token);
        }
        writeJson(response, 200, attached);
        return true;
      }
      await stream(request, response, actor, selector, service, url);
      return true;
    } catch (error) {
      if (response.headersSent) {
        if (!response.destroyed) response.end();
        return true;
      }
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: error.message }
        });
      } else if (error instanceof CodexMachineTasksConflictError) {
        writeJson(response, 409, {
          error: { code: 'operation_conflict', message: error.message }
        });
      } else if (error instanceof HttpError) {
        writeJson(response, error.statusCode, {
          error: { code: 'invalid_request', message: error.message }
        });
      } else {
        writeJson(response, 503, {
          error: {
            code: 'codex_machine_tasks_unavailable',
            message: 'Codex machine tasks are temporarily unavailable.'
          }
        });
      }
      return true;
    }
  };
}

type Route =
  | { kind: 'start' }
  | { kind: 'attach' | 'read' | 'send' | 'stream'; threadId: string };

function routeFor(method: string | undefined, path: string): Route | undefined {
  if (method === 'POST' && path === '/api/codex/tasks/start') return { kind: 'start' };
  const match = path.match(/^\/api\/codex\/tasks\/([^/]+)(?:\/(attach|send|stream))?$/);
  if (!match) return undefined;
  let threadId: string;
  try { threadId = decodeURIComponent(match[1] ?? ''); } catch { return undefined; }
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) return undefined;
  if (method === 'GET' && !match[2]) return { kind: 'read', threadId };
  if (method === 'POST' && match[2] === 'attach') return { kind: 'attach', threadId };
  if (method === 'POST' && match[2] === 'send') return { kind: 'send', threadId };
  if (method === 'GET' && match[2] === 'stream') return { kind: 'stream', threadId };
  return undefined;
}

async function stream(
  request: IncomingMessage,
  response: ServerResponse,
  actor: { userId: string },
  selector: CodexMachineTaskReadRequest,
  service: CodexMachineTasksHttpService,
  url: URL
) {
  const afterSequence = numericCursor(
    request.headers['last-event-id'] ?? url.searchParams.get('afterSequence') ?? undefined
  );
  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Connection', 'keep-alive');
  const controller = new AbortController();
  request.once('close', () => controller.abort());
  await service.stream(actor, { ...selector, afterSequence }, (event, sequence) => {
    if (sequence !== undefined) response.write(`id: ${sequence}\n`);
    response.write(`event: progress\ndata: ${JSON.stringify({
      apiVersion: CODEX_MACHINE_TASKS_API_VERSION,
      event,
      ...(sequence !== undefined ? { sequence } : {}),
      type: 'progress'
    })}\n\n`);
  }, controller.signal, () => response.flushHeaders());
  response.end();
}

function selectorFromUrl(url: URL, threadId: string): CodexMachineTaskReadRequest {
  return {
    connectorId: optionalSelector(url.searchParams.get('connectorId') ?? undefined),
    physicalMachineId: optionalSelector(url.searchParams.get('physicalMachineId') ?? undefined),
    physicalMachineName: optionalSelector(url.searchParams.get('physicalMachineName') ?? undefined),
    threadId
  };
}

function selectorFromBody(body: Record<string, unknown>, threadId: string) {
  return {
    connectorId: optionalSelector(body.connectorId),
    physicalMachineId: optionalSelector(body.physicalMachineId),
    physicalMachineName: optionalSelector(body.physicalMachineName),
    threadId
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBodyBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw invalid('Request body must be a JSON object.');
  }
}

function optionalSelector(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !safeSelector.test(value)) throw invalid('Target selector is invalid.');
  return value;
}

function operation(value: unknown) {
  if (typeof value !== 'string' || !CODEX_OPERATION_ID_PATTERN.test(value)) {
    throw invalid('operationId is invalid.');
  }
  return value;
}

function requireIdempotency(request: IncomingMessage, operationId: string) {
  if (request.headers['idempotency-key'] !== operationId) {
    throw invalid('Idempotency-Key must match operationId.');
  }
}

function numericCursor(value: string | string[] | undefined) {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^[0-9]+$/.test(value)) throw invalid('Stream cursor is invalid.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalid('Stream cursor is invalid.');
  return parsed;
}

class HttpError extends Error {
  constructor(readonly statusCode: 400 | 413, message: string) { super(message); }
}

function invalid(message: string) { return new HttpError(400, message); }
