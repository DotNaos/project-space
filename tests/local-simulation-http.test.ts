import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createLocalSimulationRequestHandler } from '../server/local-simulation/http';

let baseUrl = '';
let directory = '';
let server: Server;
let statePath = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'project-space-simulation-test-'));
  statePath = join(directory, 'runtime', 'state.json');
  const handler = createLocalSimulationRequestHandler({
    binding: {
      apis: 'simulated', data: 'local', network: 'loopback-only', secrets: 'none',
      simulationStatePath: statePath
    },
    repositoryRoot: directory
  });
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { force: true, recursive: true });
});

async function json(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  expect(response.ok).toBe(true);
  return response.json() as Promise<Record<string, unknown>>;
}

describe('local simulation HTTP runtime', () => {
  test('publishes proven runtime evidence and owner-private state', async () => {
    const meta = await json('/api/app/meta');
    expect(meta.runtime).toEqual({
      apis: 'simulated', data: 'local', network: 'loopback-only', secrets: 'none'
    });
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
  });

  test('keeps simulated Tailscale connection metadata read-only and credential-free', async () => {
    expect(await json('/api/compute/tailscale/connection')).toMatchObject({
      connectionState: 'not_configured', requiredScope: 'devices:core:read', source: 'not_connected'
    });

    for (const method of ['POST', 'DELETE'] as const) {
      const response = await fetch(`${baseUrl}/api/compute/tailscale/connection`, {
        method
      });
      expect(response.status).toBe(405);
      expect(JSON.stringify(await response.json())).not.toContain('simulated-secret');
    }

    const inventory = await json('/api/compute/tailscale/devices') as {
      devices: never[];
      provider: { connectionState: string; source: string };
    };
    expect(inventory.provider).toMatchObject({ connectionState: 'not_configured', source: 'not_connected' });
    expect(inventory.devices).toHaveLength(0);
  });

  test('persists mutations and fully resets optional scenario state', async () => {
    const start = await json('/api/codex/tasks/start', {
      body: JSON.stringify({ issue: 616, operationId: 'local-test-operation' }),
      method: 'POST'
    });
    expect(start.state).toBe('confirmed');
    expect((await json('/api/codex/tasks/existing?connectorId=local-simulation-machine&issue=616&repositoryId=DotNaos%2Fproject-space')).state).toBe('confirmed');
    expect((await json('/api/codex/tasks/existing?connectorId=local-simulation-machine&issue=617&repositoryId=DotNaos%2Fproject-space')).state).toBe('missing');
    expect((await json('/api/codex/tasks/existing?connectorId=another-machine&issue=616&repositoryId=DotNaos%2Fproject-space')).state).toBe('missing');
    expect((await json('/api/codex/tasks/existing?connectorId=local-simulation-machine&issue=616&repositoryId=DotNaos%2Fanother-repository')).state).toBe('missing');

    const reset = await json('/api/local-simulation/reset', { method: 'POST' });
    expect(Number(reset.revision)).toBeGreaterThan(1);
    expect((await json('/api/codex/tasks/existing?connectorId=local-simulation-machine&issue=616&repositoryId=DotNaos%2Fproject-space')).state).toBe('missing');
  });

  test('keeps simulated provider identities coherent', async () => {
    const details = await json('/api/github/repository-details?fullName=DotNaos%2Fproject-space');
    const worktrees = await json('/api/projects/worktrees?projectId=github%3ADotNaos%2Fproject-space');
    const issue = (details.issues as Array<{ number: number }>)[0];
    const pullRequest = (details.pullRequests as Array<{ headSha: string; linkedIssueNumbers: number[] }>)[0];
    const worktree = (worktrees.worktrees as Array<{ headSha: string }>)[0];
    expect(issue.number).toBe(616);
    expect(pullRequest.linkedIssueNumbers).toContain(issue.number);
    expect(worktree.headSha).toBe(pullRequest.headSha);
  });

  test('projects the simulated Connector through the canonical compute hierarchy', async () => {
    const overview = await json('/api/connectors/overview');
    const inventory = overview.computeInventory as {
      connectors: Array<{ connectorId: string; environmentId: string }>;
      environments: Array<{ id: string; platformId: string }>;
      platforms: Array<{ id: string }>;
    };

    expect(inventory.connectors).toHaveLength(1);
    expect(inventory.connectors[0]?.connectorId).toBe('local-simulation-machine');
    expect(inventory.environments).toHaveLength(1);
    expect(inventory.environments[0]?.id).toBe(inventory.connectors[0]?.environmentId);
    expect(inventory.platforms.map(({ id }) => id)).toContain(
      inventory.environments[0]?.platformId
    );
  });

  test('does not simulate retired Connector credential or project-registry endpoints', async () => {
    for (const path of ['/api/connectors/credentials', '/api/connectors/project-registry']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: 'canonical_runtime_required' });
    }
  });

  test('provides an author profile picture for simulated comments', async () => {
    const comments = await json('/api/github/issue-comments?number=616');
    expect(comments.comments).toMatchObject([{
      author: 'Hecate',
      authorAvatarUrl: expect.stringMatching(/^data:image\/svg\+xml,/)
    }]);

    const created = await json('/api/github/issue-comments', {
      body: JSON.stringify({ body: 'A comment with a local profile picture.', number: 616 }),
      method: 'POST'
    });
    expect(created.comment).toMatchObject({
      author: 'Hecate',
      authorAvatarUrl: expect.stringMatching(/^data:image\/svg\+xml,/)
    });
  });

  test('materializes a simulated branch into coherent local worktree state', async () => {
    const created = await json('/api/worktrees/materialize', {
      body: JSON.stringify({
        branchName: 'main',
        machineId: 'local-simulation-machine',
        projectId: 'github:DotNaos/project-space'
      }),
      method: 'POST'
    });
    expect(created).toMatchObject({ branchName: 'main', state: 'created' });

    const replayed = await json('/api/worktrees/materialize', {
      body: JSON.stringify({
        branchName: 'main',
        machineId: 'local-simulation-machine',
        projectId: 'github:DotNaos/project-space'
      }),
      method: 'POST'
    });
    expect(replayed).toMatchObject({ branchName: 'main', state: 'ready' });

    const worktrees = await json('/api/projects/worktrees?projectId=github%3ADotNaos%2Fproject-space');
    expect((worktrees.worktrees as Array<{ branchName: string }>).filter(
      (worktree) => worktree.branchName === 'main'
    )).toHaveLength(1);
  });

  test('supports local development server controls', async () => {
    const stopped = await json('/api/dev-servers/stop', { method: 'POST' });
    expect(stopped.servers).toMatchObject([{ state: 'stopped' }]);

    const inspected = await json('/api/dev-servers/inspect', { method: 'POST' });
    expect(inspected.servers).toMatchObject([{ state: 'stopped' }]);

    const started = await json('/api/dev-servers/start', { method: 'POST' });
    expect(started.servers).toMatchObject([{ state: 'running' }]);
  });

  test('supports an idempotent issue-to-branch-to-pull-request journey', async () => {
    const issueRequest = {
      body: 'Created without GitHub.',
      fullName: 'DotNaos/project-space',
      operationId: 'simulation-create-issue',
      title: 'Exercise the local provider journey'
    };
    const created = await json('/api/github/issues', {
      body: JSON.stringify(issueRequest), method: 'POST'
    });
    const replayed = await json('/api/github/issues', {
      body: JSON.stringify(issueRequest), method: 'POST'
    });
    const issue = created.issue as { number: number };
    expect(replayed).toMatchObject({ replayed: true, issue: { number: issue.number } });

    const development = await json('/api/github/issue-development', {
      body: JSON.stringify({
        branchName: `issue-${issue.number}-local-provider`,
        fullName: 'DotNaos/project-space',
        issueNumber: issue.number
      }),
      method: 'POST'
    });
    expect(development).toMatchObject({
      branchDisposition: 'created',
      pullRequestDisposition: 'created',
      state: 'ready',
      status: 'connected'
    });

    const details = await json('/api/github/repository-details?fullName=DotNaos%2Fproject-space');
    expect((details.branches as Array<{ name: string }>).some(
      (branch) => branch.name === `issue-${issue.number}-local-provider`
    )).toBe(true);
    expect((details.pullRequests as Array<{ linkedIssueNumbers?: number[] }>).some(
      (pullRequest) => pullRequest.linkedIssueNumbers?.includes(issue.number)
    )).toBe(true);

    const concurrentRequest = {
      ...issueRequest,
      operationId: 'simulation-concurrent-create',
      title: 'One issue from concurrent retries'
    };
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => json('/api/github/issues', {
      body: JSON.stringify(concurrentRequest), method: 'POST'
    })));
    expect(new Set(concurrent.map((result) => (result.issue as { number: number }).number)).size).toBe(1);
    const afterConcurrent = await json('/api/github/repository-details?fullName=DotNaos%2Fproject-space');
    expect((afterConcurrent.issues as Array<{ title: string }>).filter(
      (candidate) => candidate.title === concurrentRequest.title
    )).toHaveLength(1);
  });
});
