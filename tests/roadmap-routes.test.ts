import { describe, expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { createProjectSpaceIntegrationApiRoutes } from '../server/project-space-api-integration-routes';
import type { ProjectSpaceBackend, RoadmapResult } from '../src/shared/project-space-api';

function request(method: string, body?: unknown) {
  const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  input.method = method;
  input.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  return input;
}

function responseRecorder() {
  let body = '';
  let status = 0;
  const headers = new Map<string, string>();
  const response = {
    end(value?: string) { body = value ?? ''; },
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    writeHead(code: number, values?: Record<string, string>) {
      status = code;
      Object.entries(values ?? {}).forEach(([name, value]) => headers.set(name.toLowerCase(), value));
      return response;
    }
  } as unknown as ServerResponse;
  return { read: () => ({ body: body ? JSON.parse(body) : undefined, headers, status }), response };
}

const result: RoadmapResult = {
  canEdit: true,
  checkedAt: '2026-07-19T00:00:00.000Z',
  dependencies: [],
  dependencySync: 'current',
  graphRevision: '12345678',
  issues: [],
  plan: { goals: [], items: [], revision: 0 },
  repository: { fullName: 'DotNaos/project-space', id: 42 },
  status: 'connected'
};

describe('roadmap HTTP routes', () => {
  test('dispatches reads, plan writes and dependency writes without caching', async () => {
    const calls: Array<[string, unknown]> = [];
    const backend = {
      async addRoadmapDependency(value: unknown) { calls.push(['add', value]); return result; },
      async getRoadmap(value: string) { calls.push(['get', value]); return result; },
      async removeRoadmapDependency(value: unknown) { calls.push(['remove', value]); return result; },
      async updateRoadmapPlan(value: unknown) { calls.push(['plan', value]); return result; }
    } as unknown as ProjectSpaceBackend;
    const route = createProjectSpaceIntegrationApiRoutes(backend);
    const plan = {
      expectedGraphRevision: '12345678',
      expectedRevision: 0,
      fullName: 'DotNaos/project-space',
      goals: [],
      items: []
    };
    const dependency = {
      blockedIssueNumber: 211,
      blocker: { fullName: 'DotNaos/project-space', issueNumber: 185 },
      expectedGraphRevision: '12345678',
      fullName: 'DotNaos/project-space'
    };
    for (const [method, path, body] of [
      ['GET', '/api/github/roadmap?fullName=DotNaos%2Fproject-space', undefined],
      ['PUT', '/api/github/roadmap/plan', plan],
      ['POST', '/api/github/roadmap/dependencies', dependency],
      ['DELETE', '/api/github/roadmap/dependencies', dependency]
    ] as const) {
      const output = responseRecorder();
      expect(await route(request(method, body), output.response, new URL(`http://project.test${path}`))).toBe(true);
      expect(output.read().status).toBe(200);
      expect(output.read().headers.get('cache-control')).toBe('private, no-store');
    }
    expect(calls.map(([name]) => name)).toEqual(['get', 'plan', 'add', 'remove']);
  });

  test('rejects malformed roadmap writes before backend dispatch', async () => {
    let calls = 0;
    const backend = {
      async addRoadmapDependency() { calls += 1; return result; },
      async removeRoadmapDependency() { calls += 1; return result; },
      async updateRoadmapPlan() { calls += 1; return result; }
    } as unknown as ProjectSpaceBackend;
    const route = createProjectSpaceIntegrationApiRoutes(backend);
    const cases = [
      ['PUT', '/api/github/roadmap/plan', { expectedRevision: -1, fullName: 'a/b', goals: [], items: [] }],
      ['PUT', '/api/github/roadmap/plan', { expectedGraphRevision: '', expectedRevision: 0, fullName: 'a/b' }],
      ['POST', '/api/github/roadmap/dependencies', { blockedIssueNumber: 0, blocker: { fullName: 'a/b', issueNumber: 1 }, expectedGraphRevision: '', fullName: 'a/b' }],
      ['DELETE', '/api/github/roadmap/dependencies', { blockedIssueNumber: 1, blocker: { fullName: '', issueNumber: -1 }, expectedGraphRevision: '', fullName: 'a/b' }]
    ] as const;
    for (const [method, path, body] of cases) {
      const output = responseRecorder();
      expect(await route(request(method, body), output.response, new URL(`http://project.test${path}`))).toBe(true);
      expect(output.read().status).toBe(400);
    }
    expect(calls).toBe(0);
  });
});
