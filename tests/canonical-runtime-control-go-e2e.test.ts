import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { MemoryCanonicalRuntimeControlOperationStore } from '../server/canonical-runtime-control/memory-operation-store';
import { createCanonicalRuntimeControlService } from '../server/canonical-runtime-control/service';
import { createWorkspaceRuntimeControlDispatcher } from '../server/canonical-runtime-control/workspace-runtime-dispatcher';
import { createCanonicalRuntimeControlHttpApi } from '../server/canonical-runtime-control/http';
import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import { createWorkspaceRuntimeSessionUpgradeHandler } from '../server/workspace-runtime-session/upgrade-handler';
import { workspaceRuntimeBaseCapabilities, workspaceRuntimeControlCapability } from
  '../src/shared/workspace-runtime-session-api';
import type { ComputeInventorySnapshot } from '../src/shared/compute-environment-api';

const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = '22222222-2222-4222-8222-222222222222';
const manifestDigest = 'b'.repeat(64);
const ownerUserId = 'owner-e2e';
const runtimeVersion = '0.5.0-e2e';
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
  test('drives HTTP through the real outbound socket and Go receiver for all inspection operations', async () => {
    const workspace = join(root, 'workspace');
    await run('git', ['init', '-b', 'issue-657', workspace]);
    await run('git', ['-C', workspace, 'config', 'user.name', 'Project Test']);
    await run('git', ['-C', workspace, 'config', 'user.email', 'project@example.invalid']);
    await run('git', ['-C', workspace, 'config', 'extensions.worktreeConfig', 'true']);
    await run('git', ['-C', workspace, 'config', '--worktree', 'project.workspaceId', workspaceId]);
    await writeFile(join(workspace, 'tracked.txt'), 'before\n', { mode: 0o600 });
    await run('git', ['-C', workspace, 'add', 'tracked.txt']);
    await run('git', ['-C', workspace, 'commit', '-m', 'fixture']);
    const commit = (await run('git', ['-C', workspace, 'rev-parse', 'HEAD'])).trim();
    await writeFile(join(workspace, 'tracked.txt'), 'after\n', { mode: 0o600 });

    const sessionStore = new MemoryRuntimeSessionStore(undefined, undefined, () => 'E'.repeat(43));
    const operationStore = new MemoryCanonicalRuntimeControlOperationStore();
    const sessions = new WorkspaceRuntimeSessionService(
      sessionStore, undefined, undefined,
      { read: (...args) => operationStore.watermarks(...args) }
    );
    const dispatcher = createWorkspaceRuntimeControlDispatcher(sessions, operationStore);
    const service = createCanonicalRuntimeControlService({
      authorizer: { async authorize() { return true; } },
      dispatcher,
      inventory: {
        async compute() { return computeInventory(); },
        async runtimes() { return sessions.list(ownerUserId); }
      }
    });
    const http = createCanonicalRuntimeControlHttpApi(service, async () => ({
      actorId: 'machine-e2e', actorKind: 'agent', ownerUserId
    }));
    const gateway = createWorkspaceRuntimeSessionUpgradeHandler(sessions);
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!await http(request, response, url)) response.writeHead(404).end();
    });
    server.on('upgrade', (request, socket, head) => {
      if (!gateway.handleUpgrade(request, socket, head)) socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address.');
    const origin = `http://127.0.0.1:${address.port}`;

    const credential = await sessionStore.issue({
      branch: 'issue-657', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'launch-e2e', ownerUserId,
      requestedCapabilities: [workspaceRuntimeControlCapability], runtimeVersion, workspaceId
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
      branch: 'issue-657', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      endpoint: `${origin.replace('http:', 'ws:')}/api/workspace-runtimes/socket`,
      environmentId, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), generation,
      journalPath: join(runtimeHome, 'session.json'), manifestDigest, ownerUserId,
      readyPath: join(runtimeHome, 'ready'), requestedCapabilities: [workspaceRuntimeControlCapability],
      runtimeVersion, statePath, token: credential.credential.token, workspaceId,
      workspacePath: workspace
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
          snapshot.capabilities.includes(workspaceRuntimeControlCapability);
      });
      for (const operation of ['git.status', 'git.diff', 'worktree.list', 'dev-server.inspect'] as const) {
        const operationId = `e2e:${operation}`;
        currentOperationId = operationId;
        const response = await fetch(`${origin}/api/runtime-control/v1/operations`, {
          body: JSON.stringify({
            apiVersion: 1, environmentId, expectedGeneration: generation,
            expectedTargetIdentityRevision: '7:environment:canonical', operation, operationId,
            ...(operation === 'git.diff' ? { staged: false } : {}), workspaceId
          }),
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationId },
          method: 'POST', signal: AbortSignal.timeout(5_000)
        });
        const body = await response.json();
        expect({ body, status: response.status }).toMatchObject({
          body: { operation, state: 'completed' }, status: 200
        });
      }
    } catch (error) {
      failure = error;
    } finally {
      runtime.kill('SIGKILL');
      await runtime.exited;
      const runtimeError = await new Response(runtime.stderr).text();
      await gateway.close();
      server.closeAllConnections();
      dispatcher.close();
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
