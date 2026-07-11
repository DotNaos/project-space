import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ProjectChatError,
  type ProjectChatAcknowledgeInput,
  type ProjectChatContext,
  type ProjectChatErrorCode,
  type ProjectChatJoinInput,
  type ProjectChatMentionStateInput,
  type ProjectChatPresenceInput,
  type ProjectChatReadInput,
  type ProjectChatSendInput
} from './contracts';
import type { ProjectChatService } from './service';
import { writeJson } from '../project-space-http-response';

const PROJECT_CHAT_MAX_HTTP_BODY_BYTES = 16 * 1024;
const NUMERIC_QUERY_FIELDS = new Set(['afterSequence', 'limit']);

type ProjectChatContextResolver = (
  request: IncomingMessage
) => Promise<ProjectChatContext>;

type ProjectChatRoute =
  | 'ack'
  | 'join'
  | 'members'
  | 'mentions'
  | 'presence'
  | 'read'
  | 'send';

class ProjectChatHttpInputError extends Error {
  constructor(
    readonly statusCode: 400 | 413,
    readonly code: 'invalid_request' | 'request_too_large',
    message: string
  ) {
    super(message);
    this.name = 'ProjectChatHttpInputError';
  }
}

export class ProjectChatAccessError extends Error {
  readonly code: 'access_denied' | 'authentication_required' | 'service_unavailable';

  constructor(readonly statusCode: 401 | 403 | 503) {
    super(
      statusCode === 401
        ? 'Project Chat authentication is required.'
        : statusCode === 403
          ? 'Project Chat access is denied.'
          : 'Project Chat is temporarily unavailable.'
    );
    this.name = 'ProjectChatAccessError';
    this.code = statusCode === 401
      ? 'authentication_required'
      : statusCode === 403
        ? 'access_denied'
        : 'service_unavailable';
  }
}

export function createProjectChatHttpApi(
  service: ProjectChatService,
  resolveContext: ProjectChatContextResolver
) {
  return async function handleProjectChatHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    const route = projectChatRoute(request.method, url.pathname);
    if (!route) {
      return false;
    }

    response.setHeader('Cache-Control', 'no-store');

    try {
      const context = await resolveContext(request);
      const result = await handleRoute(route, request, url, service, context);
      writeJson(response, 200, result);
    } catch (error) {
      writeProjectChatError(response, error);
    }

    return true;
  };
}

async function handleRoute(
  route: ProjectChatRoute,
  request: IncomingMessage,
  url: URL,
  service: ProjectChatService,
  context: ProjectChatContext
) {
  switch (route) {
    case 'ack':
      return service.acknowledge(
        context,
        await readJsonObject<ProjectChatAcknowledgeInput>(request)
      );
    case 'join':
      return service.join(context, await readJsonObject<ProjectChatJoinInput>(request));
    case 'members':
      return { members: await service.listMembers(context) };
    case 'mentions':
      return service.getMentionState(
        context,
        queryInput(url) as unknown as ProjectChatMentionStateInput
      );
    case 'presence':
      return service.updatePresence(
        context,
        await readJsonObject<ProjectChatPresenceInput>(request)
      );
    case 'read':
      return service.readMessages(
        context,
        queryInput(url) as unknown as ProjectChatReadInput
      );
    case 'send': {
      const input = await readJsonObject<ProjectChatSendInput>(request);
      requireMatchingIdempotencyHeader(request, input);
      return { message: await service.sendMessage(context, input) };
    }
  }
}

function projectChatRoute(method: string | undefined, pathname: string): ProjectChatRoute | undefined {
  switch (`${method ?? ''} ${pathname}`) {
    case 'POST /api/project-chat/ack':
      return 'ack';
    case 'POST /api/project-chat/join':
      return 'join';
    case 'GET /api/project-chat/members':
      return 'members';
    case 'GET /api/project-chat/mentions':
      return 'mentions';
    case 'POST /api/project-chat/presence':
      return 'presence';
    case 'GET /api/project-chat/messages':
      return 'read';
    case 'POST /api/project-chat/messages':
      return 'send';
    default:
      return undefined;
  }
}

async function readJsonObject<T extends object>(request: IncomingMessage): Promise<T> {
  const declaredLength = request.headers['content-length'];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined && !/^\d+$/.test(declaredLength))
  ) {
    throw invalidRequest('The request has an invalid content length.');
  }
  if (declaredLength !== undefined && Number(declaredLength) > PROJECT_CHAT_MAX_HTTP_BODY_BYTES) {
    throw requestTooLarge();
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > PROJECT_CHAT_MAX_HTTP_BODY_BYTES) {
      throw requestTooLarge();
    }
    chunks.push(buffer);
  }

  const source = Buffer.concat(chunks).toString('utf8').trim();
  let value: unknown = {};
  try {
    value = source ? JSON.parse(source) : {};
  } catch {
    throw invalidRequest('The request body must be valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('The request body must be a JSON object.');
  }
  return value as T;
}

function queryInput(url: URL) {
  const input: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(input, key)) {
      throw invalidRequest('Query parameters must not be repeated.');
    }
    input[key] = NUMERIC_QUERY_FIELDS.has(key) && /^\d+$/.test(value)
      ? Number(value)
      : value;
  }
  return input;
}

function requireMatchingIdempotencyHeader(
  request: IncomingMessage,
  input: ProjectChatSendInput
) {
  const header = request.headers['idempotency-key'];
  if (header === undefined) {
    return;
  }
  if (Array.isArray(header) || header !== input.idempotencyKey) {
    throw invalidRequest('Idempotency-Key must match the request body.');
  }
}

function writeProjectChatError(response: ServerResponse, error: unknown) {
  if (error instanceof ProjectChatAccessError) {
    writeJson(response, error.statusCode, {
      error: { code: error.code, message: error.message }
    });
    return;
  }
  if (error instanceof ProjectChatHttpInputError) {
    writeJson(response, error.statusCode, {
      error: { code: error.code, message: error.message }
    });
    return;
  }
  if (error instanceof ProjectChatError) {
    writeJson(response, projectChatErrorStatus(error.code), {
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs })
      }
    });
    return;
  }
  writeJson(response, 500, {
    error: {
      code: 'internal_error',
      message: 'Unexpected Project Chat error.'
    }
  });
}

function projectChatErrorStatus(code: ProjectChatErrorCode) {
  const statuses: Record<ProjectChatErrorCode, number> = {
    content_rejected: 422,
    cursor_out_of_range: 409,
    idempotency_conflict: 409,
    invalid_request: 400,
    name_conflict: 409,
    not_member: 403,
    rate_limited: 429
  };
  return statuses[code];
}

function invalidRequest(message: string) {
  return new ProjectChatHttpInputError(400, 'invalid_request', message);
}

function requestTooLarge() {
  return new ProjectChatHttpInputError(
    413,
    'request_too_large',
    'The request body is too large.'
  );
}
