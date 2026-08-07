import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { observeHttpRequest } from '../server/http-observability';
import {
  createProjectSpaceLogger,
  runWithObservabilityContext,
  type ProjectSpaceLogRecord
} from '../server/observability';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('Project Space observability', () => {
  test('emits structured, correlated logs and redacts sensitive fields', () => {
    const records: ProjectSpaceLogRecord[] = [];
    const logger = createProjectSpaceLogger({
      environment: {
        NODE_ENV: 'test',
        PROJECT_SPACE_BUILD_COMMIT: 'abcdef1234567890',
        PROJECT_SPACE_BUILD_VERSION: '1.2.3'
      },
      sink: { write: (record) => records.push(record) }
    });

    runWithObservabilityContext({ requestId: 'request-observability-1' }, () => {
      logger.error('test.failed', {
        authorization: 'Bearer secret-access-token',
        nested: { refreshToken: 'refresh-secret', safe: 'visible' },
        text: 'Bearer another-secret'
      }, new Error('Test failure'));
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      commit: 'abcdef1234567890',
      environment: 'test',
      event: 'test.failed',
      level: 'error',
      requestId: 'request-observability-1',
      version: '1.2.3'
    });
    expect(records[0]?.authorization).toBe('[REDACTED]');
    expect(records[0]?.nested).toEqual({ refreshToken: '[REDACTED]', safe: 'visible' });
    expect(records[0]?.text).toBe('Bearer [REDACTED]');
    expect(records[0]?.error).toMatchObject({ message: 'Test failure', name: 'Error' });
    expect(String((records[0]?.error as { stack?: string }).stack)).toContain('Test failure');
    expect(JSON.stringify(records[0])).not.toContain('secret-access-token');
    expect(JSON.stringify(records[0])).not.toContain('refresh-secret');
  });

  test('captures unhandled HTTP errors with a client-visible request ID', async () => {
    const records: ProjectSpaceLogRecord[] = [];
    const logger = createProjectSpaceLogger({
      environment: { NODE_ENV: 'test' },
      sink: { write: (record) => records.push(record) }
    });
    const server = createServer((request, response) => {
      void observeHttpRequest(request, response, async () => {
        throw new Error('Boundary exploded');
      }, logger);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing address.');

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp?access_token=never-log`, {
      headers: {
        Authorization: 'Bearer never-log',
        'X-Request-ID': 'request-observability-http'
      }
    });

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('request-observability-http');
    expect(await response.json()).toEqual({
      error: 'Internal server error.',
      requestId: 'request-observability-http'
    });
    expect(records.find((record) => record.event === 'http.request.failed')).toMatchObject({
      requestId: 'request-observability-http',
      route: '/mcp'
    });
    expect(JSON.stringify(records)).not.toContain('never-log');
  });
});
