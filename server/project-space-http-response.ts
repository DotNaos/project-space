import type { IncomingMessage, ServerResponse } from 'node:http';

const loopbackHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function projectSpaceCorsHeaders(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.NODE_ENV !== 'development') {
    return {};
  }

  const configuredOrigin = environment.PROJECT_SPACE_DEV_CORS_ORIGIN;
  if (!configuredOrigin) {
    return {};
  }

  try {
    const origin = new URL(configuredOrigin);
    const isLoopbackOrigin = loopbackHostnames.has(origin.hostname.toLowerCase());
    const isHttpOrigin = origin.protocol === 'http:' || origin.protocol === 'https:';
    const hasOnlyOrigin =
      origin.pathname === '/' &&
      origin.search === '' &&
      origin.hash === '' &&
      origin.username === '' &&
      origin.password === '';

    if (!isLoopbackOrigin || !isHttpOrigin || !hasOnlyOrigin) {
      return {};
    }

    return {
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Allow-Origin': origin.origin,
      Vary: 'Origin'
    };
  } catch {
    return {};
  }
}

export function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    ...projectSpaceCorsHeaders(),
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload));
}

export function writeEmpty(response: ServerResponse, statusCode = 204) {
  response.writeHead(statusCode, projectSpaceCorsHeaders());
  response.end();
}

export function writeText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/plain; charset=utf-8'
) {
  response.writeHead(statusCode, {
    ...projectSpaceCorsHeaders(),
    'Cache-Control': 'no-store',
    'Content-Type': contentType
  });
  response.end(body);
}

export async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 2 * 1024 * 1024) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString('utf-8').trim();
  return (body ? JSON.parse(body) : {}) as T;
}
