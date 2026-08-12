import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MemoryCanonicalRuntimeControlOperationStore } from '../server/canonical-runtime-control/memory-operation-store';
import { createCanonicalRuntimeControlRuntime } from '../server/canonical-runtime-control/configured-runtime';
import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import { createWorkspaceRuntimeSessionUpgradeHandler } from '../server/workspace-runtime-session/upgrade-handler';
import {
  workspaceRuntimeBaseCapabilities, workspaceRuntimeControlCapability,
  workspaceRuntimeMutationCapability
} from
  '../src/shared/workspace-runtime-session-api';
import type { ComputeInventorySnapshot } from '../src/shared/compute-environment-api';

const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = '22222222-2222-4222-8222-222222222222';
const manifestDigest = 'b'.repeat(64);
const ownerUserId = 'owner-e2e';
const runtimeVersion = '0.5.0-e2e';
const worktreeOwnerThreadId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let root = '';
let project = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'canonical-runtime-e2e-'));
  project = join(root, 'project');
  const build = Bun.spawn({
    cmd: ['go', 'build', '-o', project, './cmd/project'], stderr: 'pipe', stdout: 'pipe'
  });
  if (await build.exited !== 0) throw new Error(await new Response(build.stderr).text());
}, 30_000);

afterAll(async () => {
  if (root) await rm(root, { force: true, recursive: true });
});

describe('canonical Runtime control real Go path', () => {
  test('drives inspection and mutation HTTP through the real outbound socket and Go receiver', async () => {
    const repository = join(root, 'fixture');
    const workspace = join(root, '.worktrees', 'fixture', 'issue-658');
    await run('git', ['init', '-b', 'main', repository]);
    await run('git', ['-C', repository, 'config', 'user.name', 'Project Test']);
    await run('git', ['-C', repository, 'config', 'user.email', 'project@example.invalid']);
    await writeFile(join(repository, 'tracked.txt'), 'before\n', { mode: 0o600 });
    await run('git', ['-C', repository, 'add', 'tracked.txt']);
    await run('git', ['-C', repository, 'commit', '-m', 'fixture']);
    await run('git', ['-C', repository, 'config', 'extensions.worktreeConfig', 'true']);
    await mkdir(join(root, '.worktrees', 'fixture'), { mode: 0o700, recursive: true });
    await run('git', ['-C', repository, 'worktree', 'add', '-b', 'issue-658', workspace]);
    await run('git', ['-C', workspace, 'config', 'user.name', 'Project Test']);
    await run('git', ['-C', workspace, 'config', 'user.email', 'project@example.invalid']);
    await run('git', ['-C', workspace, 'config', '--worktree', 'project.workspaceId', workspaceId]);
    await run('git', ['-C', workspace, 'config', '--worktree', 'project.codexThreadId', worktreeOwnerThreadId]);
    await run('git', ['-C', workspace, 'config', '--worktree', 'project.worktreeManaged', 'true']);
    const commit = (await run('git', ['-C', workspace, 'rev-parse', 'HEAD'])).trim();
    await writeFile(join(workspace, 'tracked.txt'), 'after\n', { mode: 0o600 });

    const sessionStore = new MemoryRuntimeSessionStore(undefined, undefined, () => 'E'.repeat(43));
    const operationStore = new MemoryCanonicalRuntimeControlOperationStore();
    const sessions = new WorkspaceRuntimeSessionService(
      sessionStore, undefined, undefined,
      { read: (...args) => operationStore.watermarks(...args) }
    );
    const control = createCanonicalRuntimeControlRuntime({
      inventory: {
        async compute() { return computeInventory(); },
        async runtimes() { return sessions.list(ownerUserId); }
      },
      authorizer: { async authorize() { return true; } },
      machineConnection: {
        async resolveMachineCredentialIdentity(token, machineId) {
          return token === 'machine-token' && machineId === 'machine-e2e'
            ? { machineId, userId: ownerUserId }
            : null;
        }
      },
      operations: operationStore,
      runtimeSessions: sessions
    });
    const gateway = createWorkspaceRuntimeSessionUpgradeHandler(sessions);
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!await control.handleRequest(request, response, url)) response.writeHead(404).end();
    });
    server.on('upgrade', (request, socket, head) => {
      if (!gateway.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address.');
    const origin = `http://127.0.0.1:${address.port}`;

    const credential = await sessionStore.issue({
      branch: 'issue-658', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'launch-e2e', ownerUserId,
      requestedCapabilities: [workspaceRuntimeControlCapability, workspaceRuntimeMutationCapability],
      runtimeVersion, workspaceId
    });
    const runtimeHome = join(root, 'runtime');
    await mkdir(runtimeHome, { mode: 0o700 });
    await chmod(runtimeHome, 0o700);
    const bootstrap = join(runtimeHome, 'bootstrap.json');
    const statePath = join(runtimeHome, 'state.json');
    await writeFile(statePath, JSON.stringify({
      devServers: [{ name: 'docs', port: 3000, state: 'ready' }], lifecycleState: 'running'
    }), { mode: 0o600 });
    await writeFile(bootstrap, JSON.stringify({
      branch: 'issue-658', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      endpoint: `${origin.replace('http:', 'ws:')}/api/workspace-runtimes/socket`,
      environmentId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), generation,
      journalPath: join(runtimeHome, 'session.json'), manifestDigest, ownerUserId,
      readyPath: join(runtimeHome, 'ready'),
      requestedCapabilities: [workspaceRuntimeControlCapability, workspaceRuntimeMutationCapability],
      runtimeVersion, statePath, token: credential.credential.token, workspaceId,
      workspacePath: workspace, worktreeOwnerThreadId
    }), { mode: 0o600 });
    const runtime = Bun.spawn({
      cmd: [project, '__workspace-runtime-session', '--bootstrap', bootstrap],
      cwd: workspace, stderr: 'pipe', stdout: 'pipe'
    });
    let failure: unknown;
    let currentOperationId = '';
    try {
      await waitFor(async () => {
        const snapshot = (await sessions.list(ownerUserId))[0];
        return snapshot?.connectionState === 'online' && snapshot.lifecycleState === 'running' &&
          snapshot.capabilities.includes(workspaceRuntimeControlCapability) &&
          snapshot.capabilities.includes(workspaceRuntimeMutationCapability);
      });
      const deniedOperationId = 'e2e:unauthorized';
      const denied = await fetch(`${origin}/api/runtime-control/v1/operations`, {
        body: JSON.stringify({
          apiVersion: 1, environmentId, expectedGeneration: generation,
          expectedTargetIdentityRevision: '7:environment:canonical', operation: 'git.status',
          operationId: deniedOperationId, workspaceId
        }),
        headers: {
          Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json',
          'Idempotency-Key': deniedOperationId, 'X-Project-Machine-ID': 'machine-e2e'
        },
        method: 'POST'
      });
      expect(denied.status).toBe(401);
      expect(await operationStore.read(ownerUserId, deniedOperationId)).toBeUndefined();
      for (const operation of ['git.status', 'git.diff', 'worktree.list', 'dev-server.inspect'] as const) {
        const operationId = `e2e:${operation}`;
        currentOperationId = operationId;
        const response = await fetch(`${origin}/api/runtime-control/v1/operations`, {
          body: JSON.stringify({
            apiVersion: 1, environmentId, expectedGeneration: generation,
            expectedTargetIdentityRevision: '7:environment:canonical', operation, operationId,
            ...(operation === 'git.diff' ? { staged: false } : {}), workspaceId
          }),
          headers: {
            Authorization: 'Bearer machine-token', 'Content-Type': 'application/json',
            'Idempotency-Key': operationId, 'X-Project-Machine-ID': 'machine-e2e'
          },
          method: 'POST', signal: AbortSignal.timeout(5_000)
        });
        const body = await response.json();
        expect({ body, status: response.status }).toMatchObject({
          body: { operation, state: 'completed' }, status: 200
        });
      }
      const taskExecutionId = '33333333-3333-4333-8333-333333333333';
      const workspaceLeaseId = workspaceId;
      const mutations = [
        {
          input: { expectedHead: commit, operation: 'git.stage', scope: 'all' },
          output: {
            changed: true, clean: false, conflicted: 0, head: commit, staged: 1,
            truncated: false, unstaged: 0, untracked: 0
          }
        },
        {
          input: { expectedHead: commit, operation: 'git.unstage', scope: 'all' },
          output: {
            changed: true, clean: false, conflicted: 0, head: commit, staged: 0,
            truncated: false, unstaged: 1, untracked: 0
          }
        },
        {
          input: { operation: 'task.start', taskExecutionId, workspaceLeaseId },
          output: { state: 'ready_for_agent', taskExecutionId }
        },
        {
          input: { expectedHead: commit, operation: 'git.stage', scope: 'all' },
          output: {
            changed: true, clean: false, conflicted: 0, head: commit, staged: 1,
            truncated: false, unstaged: 0, untracked: 0
          }
        },
        {
          input: { expectedHead: commit, message: 'Canonical E2E commit', operation: 'git.commit' },
          output: { parent: commit }
        }
      ] as const;
      for (const [index, mutation] of mutations.entries()) {
        const operationId = `e2e:mutation:${index}`;
        currentOperationId = operationId;
        const response = await fetch(`${origin}/api/runtime-control/v1/operations`, {
          body: JSON.stringify({
            apiVersion: 1, environmentId, expectedGeneration: generation,
            expectedTargetIdentityRevision: '7:environment:canonical', operationId,
            workspaceId, ...mutation.input
          }),
          headers: {
            Authorization: 'Bearer machine-token', 'Content-Type': 'application/json',
            'Idempotency-Key': operationId, 'X-Project-Machine-ID': 'machine-e2e'
          },
          method: 'POST', signal: AbortSignal.timeout(5_000)
        });
        const body = await response.json();
        expect({ body, status: response.status }).toMatchObject({
          body: { operation: mutation.input.operation, state: 'completed' }, status: 200
        });
        if (mutation.input.operation === 'git.commit') {
          expect(body.output).toEqual({ ...mutation.output, commit: expect.stringMatching(/^[a-f0-9]{40}$/) });
        } else {
          expect(body.output).toEqual(mutation.output);
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      runtime.kill('SIGKILL');
      await runtime.exited;
      const runtimeError = await new Response(runtime.stderr).text();
      await gateway.close();
      server.closeAllConnections();
      control.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (failure) throw new Error(`${String(failure)}\nRuntime stderr: ${runtimeError}\nSessions: ${
        JSON.stringify(await sessions.list(ownerUserId))
      }\nOperation: ${JSON.stringify(await operationStore.read(ownerUserId, currentOperationId))}\nJournal: ${
        await readFile(join(runtimeHome, 'runtime-control-journal.json'), 'utf8').catch(() => 'missing')
      }`);
    }
  }, 30_000);
});

function computeInventory(): ComputeInventorySnapshot {
  return {
    connectors: [],
    environmentDefinitions: [{
      bootstrapStrategy: 'workspace_runtime', id: 'definition', kind: 'docker', name: 'Runtime',
      operatingSystemFamily: 'other', ownership: 'built_in', slug: 'runtime', supportedArchitectures: []
    }],
    environments: [{
      environmentDefinitionId: 'definition', hostAssociation: { evidence: 'none', resolution: 'not_applicable' },
      id: environmentId, identity: { key: 'environment:canonical', version: 7 }, kind: 'docker',
      name: 'Canonical runtime', platformId: 'platform', resourceMode: 'dedicated'
    }],
    hosts: [], platforms: [{ id: 'platform', kind: 'local', name: 'Local' }], violations: []
  };
}

async function run(command: string, args: string[]) {
  const child = Bun.spawn({ cmd: [command, ...args], stderr: 'pipe', stdout: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('Runtime did not connect.');
    await Bun.sleep(25);
  }
}
