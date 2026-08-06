import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CODEX_OPERATION_ID_PATTERN,
  CODEX_PERMISSION_PROFILE_ID_PATTERN,
  CODEX_THREAD_ID_PATTERN,
  type CodexSessionApprovalRequest,
  type CodexSessionBrowserRequest,
  type CodexSessionBrowserResult,
  type CodexSessionContinueRequest,
  type CodexSessionInspectRequest,
  type CodexSessionInspectResult,
  type CodexSessionInterruptRequest,
  type CodexSessionListRequest,
  type CodexSessionOperationResult,
  type CodexSessionReadRequest,
  type CodexSessionReadResult,
  type CodexSessionSettingsRequest,
  type CodexSessionListResult,
  type CodexSessionStreamEvent,
  type CodexSessionUserInputResponse
} from '../src/shared/codex-sessions-api';
import { writeJson } from './project-space-http-response';

const MAXIMUM_BODY_BYTES = 16 * 1024;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface CodexSessionsRequestContext {
  userId: string;
}

export interface CodexSessionsHttpService {
  approve(
    context: CodexSessionsRequestContext,
    request: CodexSessionApprovalRequest
  ): Promise<CodexSessionOperationResult>;
  browser(
    context: CodexSessionsRequestContext,
    request: CodexSessionBrowserRequest
  ): Promise<CodexSessionBrowserResult>;
  continue(
    context: CodexSessionsRequestContext,
    request: CodexSessionContinueRequest
  ): Promise<CodexSessionOperationResult>;
  interrupt(
    context: CodexSessionsRequestContext,
    request: CodexSessionInterruptRequest
  ): Promise<CodexSessionOperationResult>;
  inspect(
    context: CodexSessionsRequestContext,
    request: CodexSessionInspectRequest
  ): Promise<CodexSessionInspectResult>;
  list(
    context: CodexSessionsRequestContext,
    request: CodexSessionListRequest
  ): Promise<CodexSessionListResult>;
  read(
    context: CodexSessionsRequestContext,
    request: CodexSessionReadRequest
  ): Promise<CodexSessionReadResult>;
  respondToUserInput(
    context: CodexSessionsRequestContext,
    request: CodexSessionUserInputResponse
  ): Promise<CodexSessionOperationResult>;
  settings(
    context: CodexSessionsRequestContext,
    request: CodexSessionSettingsRequest
  ): Promise<CodexSessionOperationResult>;
  stream(
    context: CodexSessionsRequestContext,
    request: CodexSessionReadRequest & { afterSequence?: number },
    emit: (event: CodexSessionStreamEvent, sequence?: number) => void,
    signal: AbortSignal
  ): Promise<void>;
}

export class CodexSessionsHttpError extends Error {
  constructor(
    readonly statusCode: 400 | 401 | 403 | 404 | 409 | 413 | 502 | 503,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CodexSessionsHttpError';
  }
}

type ContextResolver = (request: IncomingMessage) => Promise<CodexSessionsRequestContext>;
type MachineAuthorizer = (
  context: CodexSessionsRequestContext,
  machineId: string
) => Promise<void>;

export type CodexSessionsHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) => Promise<boolean>;

export function createCodexSessionsHttpApi(
  service: CodexSessionsHttpService,
  resolveContext: ContextResolver,
  requireMachineAccess: MachineAuthorizer
): CodexSessionsHttpHandler {
  return async function handleCodexSessionsRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    const route = routeFor(request.method, url.pathname);
    if (!route) return false;

    response.setHeader('Cache-Control', 'private, no-store');
    try {
      const context = await resolveContext(request);
      const machineId = route.kind === 'list'
        ? requiredQuery(url, 'machineId')
        : requiredMachineId(
            url,
            route.kind === 'browser' ? ['afterImageRevision', 'machineId'] : ['machineId']
          );
      requireMachineId(machineId);
      await requireMachineAccess(context, machineId);

      if (route.kind === 'stream') {
        await streamSession(request, response, service, context, {
          machineId,
          threadId: route.threadId
        });
        return true;
      }

      const result = await executeRoute(route, request, url, service, context, machineId);
      writeJson(response, 200, result);
    } catch (error) {
      writeCodexSessionsError(response, error);
    }
    return true;
  };
}

type Route =
  | { kind: 'list' }
  | {
      kind: 'approval' | 'browser' | 'continue' | 'input' | 'inspect' | 'interrupt' | 'read' | 'settings' | 'stream';
      threadId: string;
    };

function routeFor(method: string | undefined, pathname: string): Route | undefined {
  if (method === 'GET' && pathname === '/api/codex/sessions') return { kind: 'list' };
  const match = pathname.match(/^\/api\/codex\/sessions\/([^/]+)(?:\/(browser|continue|interrupt|approval|input|inspect|settings|stream))?$/);
  if (!match) return undefined;
  let threadId = '';
  try {
    threadId = decodeURIComponent(match[1] ?? '');
  } catch {
    return undefined;
  }
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) return undefined;
  const action = match[2];
  if (method === 'GET' && !action) return { kind: 'read', threadId };
  if (method === 'GET' && action === 'browser') return { kind: 'browser', threadId };
  if (method === 'GET' && action === 'inspect') return { kind: 'inspect', threadId };
  if (method === 'GET' && action === 'stream') return { kind: 'stream', threadId };
  if (method === 'POST' && action &&
    !['browser', 'inspect', 'stream'].includes(action)) {
    return {
      kind: action as 'approval' | 'continue' | 'input' | 'interrupt' | 'settings',
      threadId
    };
  }
  return undefined;
}

async function executeRoute(
  route: Exclude<Route, { kind: 'stream' }>,
  request: IncomingMessage,
  url: URL,
  service: CodexSessionsHttpService,
  context: CodexSessionsRequestContext,
  machineId: string
) {
  if (route.kind === 'list') {
    rejectUnexpectedQuery(url, ['includeArchived', 'machineId', 'search']);
    const search = optionalQuery(url, 'search');
    if (search && search.length > 256) throw invalidRequest('Search is too long.');
    const archived = optionalQuery(url, 'includeArchived');
    if (archived !== undefined && archived !== 'true' && archived !== 'false') {
      throw invalidRequest('includeArchived must be true or false.');
    }
    return service.list(context, {
      includeArchived: archived === 'true',
      machineId,
      ...(search ? { search } : {})
    });
  }

  if (route.kind === 'read') {
    rejectUnexpectedQuery(url, ['machineId']);
    return service.read(context, { machineId, threadId: route.threadId });
  }

  if (route.kind === 'browser') {
    rejectUnexpectedQuery(url, ['afterImageRevision', 'machineId']);
    const afterImageRevision = optionalQuery(url, 'afterImageRevision');
    if (afterImageRevision !== undefined && !/^[a-f0-9]{64}$/.test(afterImageRevision)) {
      throw invalidRequest('afterImageRevision must be a SHA-256 digest.');
    }
    return service.browser(context, {
      ...(afterImageRevision ? { afterImageRevision } : {}),
      machineId,
      threadId: route.threadId
    });
  }

  if (route.kind === 'inspect') {
    rejectUnexpectedQuery(url, ['machineId']);
    return service.inspect(context, { machineId, threadId: route.threadId });
  }

  const body = await readJsonObject(request);
  if (body.machineId !== machineId) {
    throw invalidRequest('The machineId field does not match the selected machine.');
  }
  const operationId = requiredString(body, 'operationId', CODEX_OPERATION_ID_PATTERN);
  requireIdempotencyHeader(request, operationId);
  const common = { machineId, operationId, threadId: route.threadId };

  if (route.kind === 'continue') {
    onlyKeys(body, [
      'delivery',
      'effort',
      'expectedTurnId',
      'imageAttachmentIds',
      'machineId',
      'message',
      'model',
      'operationId',
      'permissionProfileId',
      'serviceTier'
    ]);
    const message = requiredString(body, 'message');
    const delivery = body.delivery === undefined
      ? undefined
      : body.delivery === 'new-turn' || body.delivery === 'steer'
        ? body.delivery
        : (() => { throw invalidRequest('The delivery mode is invalid.'); })();
    const expectedTurnId = optionalIdentifier(body, 'expectedTurnId');
    const imageAttachmentIds = optionalAttachmentIds(body.imageAttachmentIds);
    const effort = optionalIdentifier(body, 'effort');
    const model = optionalIdentifier(body, 'model');
    const permissionProfileId = body.permissionProfileId === undefined
      ? undefined
      : requiredString(
        body,
        'permissionProfileId',
        CODEX_PERMISSION_PROFILE_ID_PATTERN
      );
    const serviceTier = optionalNullableIdentifier(body, 'serviceTier');
    if (message.length > 16_000) throw invalidRequest('The message is too long.');
    if (
      delivery === 'steer'
        ? !expectedTurnId || effort !== undefined || model !== undefined ||
          permissionProfileId !== undefined || serviceTier !== undefined
        : expectedTurnId !== undefined
    ) {
      throw invalidRequest('The delivery mode fields are inconsistent.');
    }
    return service.continue(context, {
      ...common,
      ...(delivery ? { delivery } : {}),
      ...(effort ? { effort } : {}),
      ...(expectedTurnId ? { expectedTurnId } : {}),
      ...(imageAttachmentIds.length ? { imageAttachmentIds } : {}),
      message,
      ...(model ? { model } : {}),
      ...(permissionProfileId ? { permissionProfileId } : {}),
      ...(serviceTier !== undefined ? { serviceTier } : {})
    });
  }

  if (route.kind === 'settings') {
    onlyKeys(body, ['machineId', 'operationId', 'permissionProfileId']);
    const permissionProfileId = requiredString(
      body,
      'permissionProfileId',
      CODEX_PERMISSION_PROFILE_ID_PATTERN
    );
    return service.settings(context, {
      ...common,
      permissionProfileId
    });
  }

  const turnId = requiredString(body, 'turnId', REQUEST_ID_PATTERN);
  if (route.kind === 'interrupt') {
    onlyKeys(body, ['machineId', 'operationId', 'turnId']);
    return service.interrupt(context, { ...common, turnId });
  }

  const requestId = requiredString(body, 'requestId', REQUEST_ID_PATTERN);
  if (route.kind === 'approval') {
    onlyKeys(body, [
      'approvalId', 'decision', 'itemId', 'machineId', 'operationId', 'requestId', 'turnId'
    ]);
    const decision = body.decision;
    if (decision !== 'allow-once' && decision !== 'deny') {
      throw invalidRequest('The approval decision is invalid.');
    }
    return service.approve(context, {
      ...common,
      decision,
      requestId,
      turnId,
      ...(optionalIdentifier(body, 'approvalId') ? { approvalId: String(body.approvalId) } : {}),
      ...(optionalIdentifier(body, 'itemId') ? { itemId: String(body.itemId) } : {})
    });
  }

  onlyKeys(body, ['answers', 'machineId', 'operationId', 'requestId', 'turnId']);
  if (!Array.isArray(body.answers) || body.answers.length === 0 || body.answers.length > 32) {
    throw invalidRequest('User input answers are invalid.');
  }
  const answers = body.answers.map((answer) => {
    if (!isRecord(answer)) throw invalidRequest('User input answers are invalid.');
    onlyKeys(answer, ['questionId', 'value']);
    const questionId = requiredString(answer, 'questionId', REQUEST_ID_PATTERN);
    const value = requiredString(answer, 'value');
    if (value.length > 4_000) throw invalidRequest('A user input answer is too long.');
    return { questionId, value };
  });
  if (new Set(answers.map((answer) => answer.questionId)).size !== answers.length) {
    throw invalidRequest('User input answers must be unique.');
  }
  return service.respondToUserInput(context, { ...common, answers, requestId, turnId });
}

async function streamSession(
  request: IncomingMessage,
  response: ServerResponse,
  service: CodexSessionsHttpService,
  context: CodexSessionsRequestContext,
  input: CodexSessionReadRequest
) {
  const afterSequence = streamCursor(request);
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.once('aborted', abort);
  request.socket.once('close', abort);
  response.writeHead(200, {
    'Cache-Control': 'private, no-store',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8',
    'X-Accel-Buffering': 'no'
  });
  response.write('retry: 1000\n\n');
  try {
    await service.stream(context, {
      ...input,
      ...(afterSequence === undefined ? {} : { afterSequence })
    }, (event, sequence) => {
      if (!response.destroyed) {
        response.write(`id: ${sequence ?? event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    }, controller.signal);
    if (!response.destroyed) response.end();
  } finally {
    request.off('aborted', abort);
    request.socket.off('close', abort);
  }
}

function streamCursor(request: IncomingMessage) {
  const value = request.headers['last-event-id'];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^[0-9]{1,16}$/.test(value)) {
    throw invalidRequest('Last-Event-ID is invalid.');
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw invalidRequest('Last-Event-ID is invalid.');
  }
  return cursor;
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAXIMUM_BODY_BYTES) {
      throw new CodexSessionsHttpError(413, 'request_too_large', 'The request is too large.');
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!isRecord(value)) throw new Error('not-object');
    return value;
  } catch {
    throw invalidRequest('The request body must be a JSON object.');
  }
}

function requiredMachineId(url: URL, allowedQuery: string[]) {
  const value = requiredQuery(url, 'machineId');
  rejectUnexpectedQuery(url, allowedQuery);
  return value;
}

function requiredQuery(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  if (values.length !== 1 || !values[0]) throw invalidRequest(`Missing ${key}.`);
  return values[0];
}

function optionalQuery(url: URL, key: string) {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw invalidRequest(`${key} must not be repeated.`);
  return values[0];
}

function rejectUnexpectedQuery(url: URL, allowed: string[]) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) throw invalidRequest('The request contains an unsupported query.');
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  pattern?: RegExp
) {
  const result = value[key];
  if (typeof result !== 'string' || result.trim() !== result || !result || pattern && !pattern.test(result)) {
    throw invalidRequest(`The ${key} field is invalid.`);
  }
  return result;
}

function optionalIdentifier(value: Record<string, unknown>, key: string) {
  return value[key] === undefined ? undefined : requiredString(value, key, REQUEST_ID_PATTERN);
}

function optionalNullableIdentifier(value: Record<string, unknown>, key: string) {
  return value[key] === null ? null : optionalIdentifier(value, key);
}

function optionalAttachmentIds(value: unknown) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 3 ||
    value.some(
      (id) =>
        typeof id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ) ||
    new Set(value).size !== value.length
  ) {
    throw invalidRequest('The image attachments are invalid.');
  }
  return value as string[];
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw invalidRequest('The request contains unsupported fields.');
  }
}

function requireMachineId(value: string) {
  if (!MACHINE_ID_PATTERN.test(value)) throw invalidRequest('The machineId field is invalid.');
}

function requireIdempotencyHeader(request: IncomingMessage, operationId: string) {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value) || value !== operationId) {
    throw invalidRequest('A matching Idempotency-Key header is required.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidRequest(message: string) {
  return new CodexSessionsHttpError(400, 'invalid_request', message);
}

function writeCodexSessionsError(response: ServerResponse, error: unknown) {
  if (response.headersSent) {
    if (!response.destroyed) response.end();
    return;
  }
  const known = error instanceof CodexSessionsHttpError ? error : undefined;
  writeJson(response, known?.statusCode ?? 500, {
    error: {
      code: known?.code ?? 'internal_error',
      message: known?.message ?? 'Codex sessions are temporarily unavailable.'
    }
  });
}
