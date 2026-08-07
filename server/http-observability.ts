import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

import {
  context,
  propagation,
  ROOT_CONTEXT,
  type TextMapGetter
} from '@opentelemetry/api';

import { writeJson } from './project-space-http-response';
import {
  createRequestId,
  projectSpaceLogger,
  recordHttpRequest,
  recordObservedError,
  runWithObservabilityContext,
  withProjectSpaceSpan,
  type ProjectSpaceLogger
} from './observability';

const headerGetter: TextMapGetter<IncomingHttpHeaders> = {
  get(carrier, key) {
    const value = carrier[key.toLowerCase()];
    return Array.isArray(value) ? value : value === undefined ? undefined : String(value);
  },
  keys(carrier) {
    return Object.keys(carrier);
  }
};

export async function observeHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: () => Promise<void>,
  logger: ProjectSpaceLogger = projectSpaceLogger
) {
  const startedAt = performance.now();
  const requestId = createRequestId(request.headers['x-request-id']);
  const method = request.method ?? 'UNKNOWN';
  const route = safePathname(request.url);
  let thrown = false;
  response.setHeader('X-Request-ID', requestId);

  let completionLogged = false;
  const complete = (closed: boolean) => {
    if (completionLogged) return;
    completionLogged = true;
    const status = thrown ? 500 : closed && !response.writableFinished ? 499 : response.statusCode;
    const fields = { durationMs: Math.round((performance.now() - startedAt) * 100) / 100, method, route, status };
    recordHttpRequest(method, route, status, fields.durationMs);
    if (status >= 500) logger.error('http.request.completed', fields);
    else if (route === '/api/health' && status < 400) logger.debug('http.request.completed', fields);
    else logger.info('http.request.completed', fields);
  };
  response.once('finish', () => complete(false));
  response.once('close', () => complete(true));

  const extractedContext = propagation.extract(ROOT_CONTEXT, request.headers, headerGetter);
  return context.with(extractedContext, () => runWithObservabilityContext({ requestId }, async () => {
    try {
      await withProjectSpaceSpan('http.request', {
        'http.request.method': method,
        'http.route': route,
        'server.address': request.headers.host ?? ''
      }, handler);
    } catch (error) {
      thrown = true;
      recordObservedError('http', 'unhandled_request_error');
      logger.error('http.request.failed', { method, route }, error);
      if (!response.headersSent) {
        writeJson(response, 500, { error: 'Internal server error.', requestId });
      } else if (!response.writableEnded) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    }
  }));
}

function safePathname(value: string | undefined) {
  try {
    return new URL(value ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return '/invalid-request-target';
  }
}
