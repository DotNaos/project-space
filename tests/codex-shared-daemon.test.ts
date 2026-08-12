import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebSocketServer } from 'ws';

import { CodexDaemonManager } from '../server/codex-daemon/manager';
import { CodexSessionManager } from '../server/codex-sessions/manager';
import { CodexOperationLedger } from '../server/codex-sessions/operation-ledger';
import {
  CodexThreadUnmaterializedError,
  type CodexAppServerTransport
} from '../server/codex-sessions/stdio-transport';
import {
  CodexWebSocketTransport,
  codexAppServerSocketPath
} from '../server/codex-sessions/websocket-transport';
import {
  CodexSessionsGrantReplayProtection,
  createCodexSessionsWireRequest,
  verifyCodexSessionsWireRequest
} from '../server/codex-sessions-connector-contract';
import {
  codexRuntimeVersionCapability,
  codexRuntimeVersionFromCapabilities
} from '../src/shared/codex-runtime-release-contract';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';

const cleanupPaths: string[] = [];
const unixSocketFixtureRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true
  })));
});

describe('managed shared Codex daemon', () => {
  test('round-trips one exact signed Codex runtime version capability', () => {
    expect(codexRuntimeVersionCapability('0.146.0'))
      .toBe('codex.runtime.version.0.146.0');
    expect(() => codexRuntimeVersionCapability('latest')).toThrow();
    expect(codexRuntimeVersionFromCapabilities([
      'codex.runtime.v1', 'codex.runtime.version.0.146.0'
    ])).toBe('0.146.0');
    expect(codexRuntimeVersionFromCapabilities([
      'codex.runtime.version.0.145.0', 'codex.runtime.version.0.146.0'
    ])).toBeUndefined();
  });

  test('uses one Unix-socket App Server and preserves canonical thread identity across clients', async () => {
    const fixture = await daemonFixture();
    const first = new CodexSessionManager({
      daemonSocketPath: fixture.socketPath,
      sharedDaemon: true
    });
    const second = new CodexSessionManager({
      daemonSocketPath: fixture.socketPath,
      sharedDaemon: true
    });

    const started = await first.startThread({
      cwd: '/mnt/c/Users/schue',
      operationId: 'shared-thread-start'
    });
    const listed = await second.listThreads();
    const read = await second.readThread(started.thread.id);

    expect(started.thread.id).toBe('019fa340-0000-7000-8000-000000000001');
    expect(listed.data.map((thread) => thread.id)).toEqual([started.thread.id]);
    expect(read.thread.id).toBe(started.thread.id);
    expect(fixture.connectionCount()).toBe(2);
    await first.close();
    await second.close();
    await fixture.close();
  });

  test('defers maintenance for a cold active thread and preserves worktree and history on reconnect', async () => {
    const fixture = await daemonFixture();
    const worktreeMarker = join(fixture.root, 'worktree', 'marker.txt');
    await mkdir(join(fixture.root, 'worktree'), { recursive: true });
    await writeFile(worktreeMarker, 'preserved');
    const producer = new CodexSessionManager({
      daemonSocketPath: fixture.socketPath,
      sharedDaemon: true
    });
    const started = await producer.startThread({
      cwd: join(fixture.root, 'worktree'),
      operationId: 'preserved-thread-start'
    });
    await producer.startTurn({
      operationId: 'preserved-turn-start', prompt: 'Keep this history', threadId: started.thread.id
    });
    await producer.close();

    const observer = new CodexSessionManager({
      daemonSocketPath: fixture.socketPath,
      sharedDaemon: true
    });
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const safety = createConnectorRuntimeMaintenanceSafetyCheck(admission, observer);
    expect(observer.maintenanceBlockers()).toContainEqual({
      kind: 'codex-runtime', state: 'uncertain'
    });
    await observer.reconcileMaintenanceState();
    expect(safety()).toEqual({
      blockers: [{ kind: 'codex-turn', state: 'active', threadId: started.thread.id }],
      certainty: 'known'
    });

    fixture.completeTurns();
    observer.invalidateMaintenanceState();
    await observer.reconcileMaintenanceState();
    const maintenance = safety();
    expect(maintenance).toMatchObject({ blockers: [], certainty: 'known' });
    expect(await readFile(worktreeMarker, 'utf8')).toBe('preserved');
    expect((await observer.readThread(started.thread.id)).thread.turns).toEqual([
      expect.objectContaining({ id: 'turn-1', status: 'completed' })
    ]);
    if (maintenance.certainty === 'known') maintenance.lease?.release();
    await observer.close();

    const reconnected = new CodexSessionManager({
      daemonSocketPath: fixture.socketPath,
      sharedDaemon: true
    });
    await reconnected.reconcileMaintenanceState();
    await expect(reconnected.startTurn({
      operationId: 'preserved-follow-up', prompt: 'Continue after reconnect',
      threadId: started.thread.id
    })).resolves.toMatchObject({ turn: { id: 'turn-2', status: 'inProgress' } });
    expect(await readFile(worktreeMarker, 'utf8')).toBe('preserved');
    await reconnected.close();
    await fixture.close();
  });

  test('recognizes an unmaterialized shared-daemon thread before its first user message', async () => {
    const fixture = await daemonFixture({ unmaterializedRead: true });
    const manager = new CodexSessionManager({
      daemonSocketPath: fixture.socketPath,
      sharedDaemon: true
    });

    const started = await manager.startThread({
      cwd: '/mnt/c/Users/schue',
      operationId: 'unmaterialized-thread-start'
    });

    await expect(manager.readThread(started.thread.id, true))
      .rejects.toBeInstanceOf(CodexThreadUnmaterializedError);
    await manager.close();
    await fixture.close();
  });

  test('does not revive a shared transport after its manager closes during connection', async () => {
    let closeCount = 0;
    let resolveTransport!: (transport: CodexAppServerTransport) => void;
    const transport: CodexAppServerTransport = {
      call: async () => ({ data: [], nextCursor: null }),
      close: async () => {
        closeCount++;
      },
      initialize: async () => undefined,
      isOpen: true,
      respond: async () => undefined
    };
    const manager = new CodexSessionManager({
      transportFactory: () => new Promise((resolve) => {
        resolveTransport = resolve;
      })
    });

    const pending = manager.listThreads();
    await Promise.resolve();
    await manager.close();
    resolveTransport(transport);

    await expect(pending).rejects.toThrow();
    expect(closeCount).toBe(1);
  });

  test('bounds a stalled Unix-socket WebSocket handshake', async () => {
    const fixtureRoot = await mkdtemp(join(unixSocketFixtureRoot, 'ps-stalled-'));
    cleanupPaths.push(fixtureRoot);
    const socketPath = join(fixtureRoot, 'app-server.sock');
    const sockets = new Set<import('node:net').Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    const startedAt = Date.now();
    await expect(CodexWebSocketTransport.connect({
      connectTimeoutMs: 20,
      onMessage: () => undefined,
      socketPath
    })).rejects.toThrow('unavailable');
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('reports a compatible authenticated local daemon ready without Remote Control', async () => {
    const fixture = await daemonFixture();
    const ledger = new CodexOperationLedger();
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: (operationId, fingerprint, action) =>
          ledger.execute(operationId, fingerprint, action)
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      appServerVersion: '0.146.0',
      authenticated: true,
      backend: 'pid',
      cliVersion: '0.146.0',
      compatible: true,
      environmentId: 'env_os_pc',
      installed: true,
      managedCodexVersion: '0.146.0',
      paired: true,
      reachable: true,
      remoteControlEnabled: true,
      remoteControlState: 'connected',
      running: true,
      state: 'ready'
    });
    await fixture.close();
  });

  test('keeps signed ensure and restart effects idempotent under duplicate operation ids', async () => {
    const fixture = await daemonFixture();
    const ledger = new CodexOperationLedger();
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: (operationId, fingerprint, action) =>
          ledger.execute(operationId, fingerprint, action)
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    const ensured = await Promise.all([
      manager.execute('ensure', 'doctor-ensure-1'),
      manager.execute('ensure', 'doctor-ensure-1')
    ]);
    const restarted = await Promise.all([
      manager.execute('restart', 'doctor-restart-1'),
      manager.execute('restart', 'doctor-restart-1')
    ]);

    expect(ensured[0]).toEqual(ensured[1]);
    expect(restarted[0]).toEqual(restarted[1]);
    expect(fixture.commands).not.toContain('disable-remote-control');
    expect(fixture.commands).not.toContain('enable-remote-control');
    expect(fixture.commands.filter((command) => command === 'start')).toHaveLength(1);
    expect(fixture.commands.filter((command) => command === 'restart')).toHaveLength(1);
    await fixture.close();
  });

  test('serializes independent repairs and restarts a stale managed daemon', async () => {
    const fixture = await daemonFixture({
      commandDelayMs: 2,
      initialAppServerVersion: '0.145.0'
    });
    const ledger = new CodexOperationLedger();
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: (operationId, fingerprint, action) =>
          ledger.execute(operationId, fingerprint, action)
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    const [ensured, restarted] = await Promise.all([
      manager.execute('ensure', 'doctor-ensure-stale'),
      manager.execute('restart', 'doctor-restart-independent')
    ]);

    expect(ensured.evidence).toMatchObject({ compatible: true, state: 'ready' });
    expect(restarted.evidence).toMatchObject({ compatible: true, state: 'ready' });
    expect(fixture.commands.filter((command) => command === 'restart')).toHaveLength(2);
    expect(fixture.maximumConcurrentCommands()).toBe(1);
    await fixture.close();
  });

  test('atomically replaces a valid but drifted managed Codex binary', async () => {
    const fixture = await daemonFixture({ initialAppServerVersion: '0.145.0' });
    const managedPath = join(
      fixture.environment.CODEX_HOME!, 'packages', 'standalone', 'current', 'codex'
    );
    await writeFile(managedPath, '#!/bin/sh\necho old\n');
    await chmod(managedPath, 0o755);
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.execute('ensure', 'repair-drifted-managed-codex'))
      .resolves.toMatchObject({ evidence: { compatible: true, state: 'ready' } });
    expect(await readFile(managedPath, 'utf8'))
      .toBe(await readFile(fixture.binaryPath, 'utf8'));
    expect(fixture.commands).toContain('restart');
    await fixture.close();
  });

  test('does not accept an unmanaged App Server as the shared managed daemon', async () => {
    const fixture = await daemonFixture({ backend: undefined });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      compatible: false,
      reachable: false,
      running: true,
      state: 'uncertain'
    });
    expect(fixture.connectionCount()).toBe(0);
    await fixture.close();
  });

  test('does not call a running daemon durable after its managed binary disappears', async () => {
    const fixture = await daemonFixture({ managedBinary: false });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      compatible: false,
      installed: false,
      running: true,
      state: 'missing'
    });
    expect(fixture.connectionCount()).toBe(0);
    await fixture.close();
  });

  test('accepts the version-pinned symlink layout installed by Codex', async () => {
    const fixture = await daemonFixture({ managedBinaryLayout: 'packaged-symlink' });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      compatible: true,
      installed: true,
      state: 'ready'
    });
    await fixture.close();
  });

  test('rejects a managed binary symlink that escapes the Codex package tree', async () => {
    const fixture = await daemonFixture({ managedBinaryLayout: 'external-symlink' });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      compatible: false,
      installed: false,
      state: 'missing'
    });
    await fixture.close();
  });

  test('rejects insecure managed binary replacements while a daemon is running', async () => {
    for (const managedBinaryMode of [0o644, 0o777]) {
      const fixture = await daemonFixture({ managedBinaryMode });
      const manager = new CodexDaemonManager({
        environment: fixture.environment,
        manager: {
          executeManagedOperation: async (_operationId, _fingerprint, action) => action()
        },
        resolveBinary: () => fixture.binaryPath,
        run: fixture.run
      });

      await expect(manager.inspect()).resolves.toMatchObject({
        compatible: false,
        installed: false,
        state: 'missing'
      });
      await fixture.close();
    }
  });

  test('bounds readiness when the App Server accepts but never answers initialize', async () => {
    const fixture = await daemonFixture({ ignoreInitialize: true });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      rpcTimeoutMs: 20,
      run: fixture.run
    });

    const startedAt = Date.now();
    await expect(manager.inspect()).resolves.toMatchObject({ state: 'uncertain' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await fixture.close();
  });

  test('keeps the connector-backed daemon ready when Remote Control is disabled', async () => {
    const fixture = await daemonFixture({
      emitRemoteStatus: false,
      remoteControlEnabled: false
    });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.inspect()).resolves.toMatchObject({
      authenticated: true,
      remoteControlEnabled: false,
      remoteControlState: 'unknown',
      state: 'ready'
    });
    await fixture.close();
  });

  test('fails closed without a pinned managed runtime and never opens a network listener', async () => {
    const fixture = await daemonFixture({ installSource: 'source' });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.execute('ensure', 'unsafe-ensure')).rejects.toThrow(
      'unpinned runtime'
    );
    expect(fixture.commands).toEqual([]);
    expect(fixture.socketPath).toStartWith(fixture.environment.CODEX_HOME!);
    await fixture.close();
  });

  test('binds daemon repair to a signed generation, machine, payload, and one-time grant', () => {
    const keys = generateKeyPairSync('ed25519');
    const request = createCodexSessionsWireRequest({
      generation: 7,
      operation: 'daemon',
      operationId: 'doctor-signed-ensure',
      payload: {
        machineId: 'remote-control:env_os_pc',
        operation: 'ensure',
        operationId: 'doctor-signed-ensure'
      },
      userId: 'owner'
    }, keys.privateKey, { nonce: 'signed-daemon-nonce', now: 1_000 });
    const replay = new CodexSessionsGrantReplayProtection();

    expect(verifyCodexSessionsWireRequest(request, 'daemon', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'remote-control:env_os_pc',
      now: 1_001,
      replayProtection: replay
    })).toEqual({ userId: 'owner' });
    expect(() => verifyCodexSessionsWireRequest(request, 'daemon', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'remote-control:env_os_pc',
      now: 1_001,
      replayProtection: replay
    })).toThrow();
    expect(() => verifyCodexSessionsWireRequest(request, 'daemon', keys.publicKey, {
      expectedGeneration: 8,
      expectedMachineId: 'remote-control:env_os_pc',
      now: 1_001
    })).toThrow();
  });
});

async function daemonFixture(options: {
  backend?: string;
  commandDelayMs?: number;
  emitRemoteStatus?: boolean;
  ignoreInitialize?: boolean;
  initialAppServerVersion?: string;
  installSource?: string;
  managedBinary?: boolean;
  managedBinaryLayout?: 'direct' | 'external-symlink' | 'packaged-symlink';
  managedBinaryMode?: number;
  remoteControlEnabled?: boolean;
  unmaterializedRead?: boolean;
} = {}) {
  const fixtureRoot = await mkdtemp(join(unixSocketFixtureRoot, 'ps-daemon-'));
  cleanupPaths.push(fixtureRoot);
  const codexHome = join(fixtureRoot, 'codex-home');
  const binaryPath = join(fixtureRoot, 'signed-codex');
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    PROJECT_SPACE_INSTALL_SOURCE: options.installSource ?? 'managed'
  };
  const socketPath = codexAppServerSocketPath(environment);
  await mkdir(join(codexHome, 'app-server-control'), { recursive: true });
  await writeFile(binaryPath, '#!/bin/sh\nexit 0\n');
  await chmod(binaryPath, 0o755);
  if (options.managedBinary !== false) {
    const standalone = join(codexHome, 'packages', 'standalone');
    const current = join(standalone, 'current');
    const layout = options.managedBinaryLayout ?? 'direct';
    if (layout === 'packaged-symlink') {
      const release = join(standalone, 'releases', '0.146.0-test');
      const managed = join(release, 'bin', 'codex');
      await mkdir(join(release, 'bin'), { recursive: true });
      await writeFile(managed, '#!/bin/sh\nexit 0\n');
      await chmod(managed, options.managedBinaryMode ?? 0o755);
      await symlink(release, current);
      await symlink('bin/codex', join(release, 'codex'));
    } else if (layout === 'external-symlink') {
      const external = join(fixtureRoot, 'external-codex');
      await writeFile(external, '#!/bin/sh\nexit 0\n');
      await chmod(external, options.managedBinaryMode ?? 0o755);
      await mkdir(current, { recursive: true });
      await symlink(external, join(current, 'codex'));
    } else {
      const managed = join(current, 'codex');
      await mkdir(current, { recursive: true });
      await writeFile(managed, '#!/bin/sh\nexit 0\n');
      await chmod(managed, options.managedBinaryMode ?? 0o755);
    }
  }

  const threads = new Map<string, Record<string, unknown>>();
  let connectionCount = 0;
  let nextTurn = 1;
  const http = createServer();
  const websocket = new WebSocketServer({ noServer: true });
  http.on('upgrade', (request, socket, head) => {
    websocket.handleUpgrade(request, socket, head, (client) => {
      websocket.emit('connection', client, request);
    });
  });
  websocket.on('connection', (client) => {
    connectionCount++;
    client.on('message', (data) => {
      const request = JSON.parse(data.toString()) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (request.method === 'initialized') {
        if (options.emitRemoteStatus === false) return;
        client.send(JSON.stringify({
          method: 'remoteControl/status/changed',
          params: {
            environmentId: 'env_os_pc',
            installationId: 'install_os_pc',
            serverName: 'os-pc',
            status: 'connected'
          }
        }));
        return;
      }
      if (request.id === undefined) return;
      let result: unknown = {};
      if (request.method === 'initialize') {
        if (options.ignoreInitialize) return;
        result = { userAgent: 'codex_app_server/0.146.0' };
      } else if (request.method === 'account/read') {
        result = { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
      } else if (request.method === 'thread/start') {
        const thread = {
          archived: false,
          cwd: request.params?.cwd,
          ephemeral: false,
          id: '019fa340-0000-7000-8000-000000000001',
          name: 'Shared task',
          preview: '',
          status: { type: 'idle' },
          turns: [],
          updatedAt: 1
        };
        threads.set(thread.id, thread);
        result = { thread };
      } else if (request.method === 'thread/list') {
        result = { data: [...threads.values()], nextCursor: null };
      } else if (request.method === 'thread/loaded/list') {
        result = { data: [...threads.keys()] };
      } else if (request.method === 'turn/start') {
        const threadId = String(request.params?.threadId);
        const thread = threads.get(threadId);
        const turn = { id: `turn-${nextTurn++}`, items: [], status: 'inProgress' };
        if (thread) {
          threads.set(threadId, {
            ...thread,
            status: { type: 'active' },
            turns: [...(Array.isArray(thread.turns) ? thread.turns : []), turn]
          });
        }
        result = { turn };
      } else if (request.method === 'thread/read' && options.unmaterializedRead) {
        client.send(JSON.stringify({
          error: {
            code: -32600,
            message: `thread ${String(request.params?.threadId)} is not materialized yet; includeTurns is unavailable before first user message`
          },
          id: request.id
        }));
        return;
      } else if (request.method === 'thread/read') {
        result = { thread: threads.get(String(request.params?.threadId)) };
      }
      client.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(socketPath, resolve);
  });

  const commands: string[] = [];
  let activeCommands = 0;
  let appServerVersion = options.initialAppServerVersion ?? '0.146.0';
  let maximumConcurrentCommands = 0;
  const run = async (_binary: string, args: string[]) => {
    if (args[0] === '--version') {
      return { exitCode: 0, stdout: 'codex-cli 0.146.0\n' };
    }
    activeCommands++;
    maximumConcurrentCommands = Math.max(maximumConcurrentCommands, activeCommands);
    try {
      if (options.commandDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.commandDelayMs));
      }
      const command = args.at(-1)!;
      commands.push(command);
      if (command === 'restart') appServerVersion = '0.146.0';
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          appServerVersion,
          ...('backend' in options ? { backend: options.backend } : { backend: 'pid' }),
          cliVersion: '0.146.0',
          managedCodexVersion: '0.146.0',
          remoteControlEnabled: options.remoteControlEnabled ?? true,
          socketPath,
          status: command === 'version' ? 'running' : 'started'
        })
      };
    } finally {
      activeCommands--;
    }
  };

  return {
    binaryPath,
    close: async () => {
      for (const client of websocket.clients) client.terminate();
      websocket.close();
      http.closeAllConnections();
      http.close();
    },
    commands,
    completeTurns: () => {
      for (const [threadId, thread] of threads) {
        threads.set(threadId, {
          ...thread,
          status: { type: 'idle' },
          turns: (Array.isArray(thread.turns) ? thread.turns : []).map((turn) => ({
            ...(turn as Record<string, unknown>), status: 'completed'
          }))
        });
      }
    },
    connectionCount: () => connectionCount,
    environment,
    maximumConcurrentCommands: () => maximumConcurrentCommands,
    root: fixtureRoot,
    run,
    socketPath
  };
}
