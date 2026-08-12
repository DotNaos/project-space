import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { createProjectSpaceCoreApiRoutes } from '../server/project-space-api-core-routes';
import { createProjectSpaceIntegrationApiRoutes } from '../server/project-space-api-integration-routes';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

describe('legacy mutation aliases', () => {
  test('fail predictably without reaching legacy Git execution', async () => {
    const fixture = routes();
    for (const pathname of ['/api/git/stage', '/api/git/unstage', '/api/git/commit']) {
      expect(await fixture.integration(request(), fixture.response, new URL(`http://project.test${pathname}`)))
        .toBe(true);
      expect(fixture.read()).toEqual({
        body: {
          error: {
            code: 'canonical_runtime_required',
            message: 'This legacy mutation requires the canonical Workspace Runtime API.'
          }
        },
        status: 409
      });
    }
    expect(fixture.calls).toEqual([]);
  });

  test('fail predictably without reaching Connector worktree or dev-server execution', async () => {
    const fixture = routes();
    for (const pathname of [
      '/api/worktrees/materialize', '/api/worktrees/setup/run',
      '/api/dev-servers/start', '/api/dev-servers/stop'
    ]) {
      expect(await fixture.core(request(), fixture.response, new URL(`http://project.test${pathname}`)))
        .toBe(true);
      expect(fixture.read()).toMatchObject({
        body: { error: { code: 'canonical_runtime_required' } },
        status: 409
      });
    }
    expect(fixture.calls).toEqual([]);
  });
});

function routes() {
  const calls: string[] = [];
  const backend = new Proxy({}, {
    get(_target, property) {
      return async () => {
        calls.push(String(property));
        throw new Error(`Legacy backend call ${String(property)} was not expected.`);
      };
    }
  }) as ProjectSpaceBackend;
  let body = '';
  let status = 0;
  const response = {
    end(value?: string) { body = value ?? ''; },
    setHeader() {},
    writeHead(code: number) { status = code; return response; }
  } as unknown as ServerResponse;
  return {
    calls,
    core: createProjectSpaceCoreApiRoutes(backend),
    integration: createProjectSpaceIntegrationApiRoutes(backend),
    read: () => ({ body: JSON.parse(body), status }),
    response
  };
}

function request() {
  const request = Readable.from([JSON.stringify({})]) as IncomingMessage;
  request.headers = { 'content-type': 'application/json' };
  request.method = 'POST';
  return request;
}
