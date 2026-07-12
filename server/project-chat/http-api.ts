import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  ProjectChatError,
  type ProjectChatAcknowledgeInput,
  type ProjectChatContext,
  type ProjectChatErrorCode,
  type ProjectChatJoinInput,
  type ProjectChatMentionStateInput,
  type ProjectChatNameClaimInput,
  type ProjectChatPresenceInput,
  type ProjectChatProfileUpdateInput,
  type ProjectChatReadInput,
  type ProjectChatSendInput
} from './contracts';
import type { ProjectChatService } from './service';
import { ProjectChatRealtimeHub } from './realtime';
import { writeJson } from '../project-space-http-response';

const PROJECT_CHAT_MAX_HTTP_BODY_BYTES = 16 * 1024;
const PROJECT_CHAT_MAX_PROFILE_HTTP_BODY_BYTES = 384 * 1024;
const NUMERIC_QUERY_FIELDS = new Set(['afterSequence', 'limit']);

type ProjectChatContextResolver = (
  request: IncomingMessage
) => Promise<ProjectChatContext>;

type ProjectChatRoute =
  | 'ack'
  | 'join'
  | 'members'
  | 'mentions'
  | 'names'
  | 'name-claim'
  | 'presence'
  | 'profile-get'
  | 'profile-update'
  | 'read'
  | 'send'
  | 'stream';

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
  resolveContext: ProjectChatContextResolver,
  realtime = new ProjectChatRealtimeHub()
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
      if (route === 'stream') {
        await streamMessages(request, response, url, service, context, realtime);
        return true;
      }
      const result = await handleRoute(route, request, url, service, context);
      if (route === 'send') {
        realtime.publish((result as { message: Awaited<ReturnType<ProjectChatService['sendMessage']>> }).message);
      }
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
    case 'names': return service.listNames(context);
    case 'name-claim': return service.claimName(context, await readJsonObject<ProjectChatNameClaimInput>(request));
    case 'presence':
      return service.updatePresence(
        context,
        await readJsonObject<ProjectChatPresenceInput>(request)
      );
    case 'profile-get':
      return { profile: await service.getProfile(context) };
    case 'profile-update':
      return service.updateProfile(
        context,
        await readJsonObject<ProjectChatProfileUpdateInput>(
          request,
          PROJECT_CHAT_MAX_PROFILE_HTTP_BODY_BYTES
        )
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
    case 'stream':
      throw new Error('Project Chat streams are handled before JSON routes.');
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
    case 'GET /api/project-chat/names': return 'names';
    case 'POST /api/project-chat/name-claims': return 'name-claim';
    case 'POST /api/project-chat/presence':
      return 'presence';
    case 'GET /api/project-chat/profile':
      return 'profile-get';
    case 'PUT /api/project-chat/profile':
      return 'profile-update';
    case 'GET /api/project-chat/messages':
      return 'read';
    case 'POST /api/project-chat/messages':
      return 'send';
    case 'GET /api/project-chat/stream':
      return 'stream';
    default:
      return undefined;
  }
}

async function streamMessages(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: ProjectChatService,
  context: ProjectChatContext,
  realtime: ProjectChatRealtimeHub
) {
  const input = queryInput(url) as unknown as ProjectChatReadInput;
  const channelId = input.channelId ?? 'general';
  let cursor = input.afterSequence ?? 0;

  // Authenticate membership and validate the cursor before committing stream headers.
  await service.readMessages(context, { afterSequence: cursor, channelId, limit: 1 });

  response.statusCode = 200;
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders?.();
  response.write('retry: 1000\n\n');

  const writeMessage = (message: Awaited<ReturnType<ProjectChatService['sendMessage']>>) => {
    if (message.sequence <= cursor || response.destroyed) {
      return;
    }
    cursor = message.sequence;
    response.write(`id: ${message.sequence}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.destroyed) response.write(': keep-alive\n\n');
  }, 15_000);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.once('aborted', cleanup);
  response.once('close', cleanup);

  let draining = Promise.resolve();
  const drain = () => {
    draining = draining.then(async () => {
      if (closed) return;
      for (;;) {
        const page = await service.readMessages(context, {
          afterSequence: cursor,
          channelId,
          limit: 100
        });
        page.messages.forEach(writeMessage);
        if (!page.hasMore) break;
      }
    }).catch(() => {
      cleanup();
      if (!response.destroyed) response.end('event: error\ndata: {"code":"stream_failed"}\n\n');
    });
    return draining;
  };
  const unsubscribe = realtime.subscribe(channelId, () => {
    void drain();
  });

  try {
    await drain();
  } catch (error) {
    cleanup();
    if (!response.headersSent) {
      throw error;
    }
  }
}

async function readJsonObject<T extends object>(
  request: IncomingMessage,
  maximumBytes = PROJECT_CHAT_MAX_HTTP_BODY_BYTES
): Promise<T> {
  const declaredLength = request.headers['content-length'];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined && !/^\d+$/.test(declaredLength))
  ) {
    throw invalidRequest('The request has an invalid content length.');
  }
  if (declaredLength !== undefined && Number(declaredLength) > maximumBytes) {
    throw requestTooLarge();
  }

  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > maximumBytes) {
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
    forbidden: 403,
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
