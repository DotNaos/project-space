import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

const cleanupPaths: string[] = [];
const unixSocketFixtureRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true
  })));
});

describe('managed shared Codex daemon', () => {
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
      authenticated: true,
      compatible: true,
      environmentId: 'env_os_pc',
      installed: true,
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
    expect(fixture.commands.filter((command) => command === 'enable-remote-control'))
      .toHaveLength(2);
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
    expect(fixture.commands.filter((command) => command === 'restart')).toHaveLength(1);
    expect(fixture.maximumConcurrentCommands()).toBe(1);
    await fixture.close();
  });

  test('replaces daemon auto-update drift with the exact signed bundled runtime', async () => {
    const fixture = await daemonFixture({
      initialAppServerVersion: '0.147.0',
      initialManagedCodexVersion: '0.147.0',
      managedBinaryLayout: 'packaged-symlink'
    });
    const updaterPid = 4_100_001;
    await mkdir(join(fixture.environment.CODEX_HOME!, 'app-server-daemon'), {
      recursive: true
    });
    await writeFile(
      join(fixture.environment.CODEX_HOME!, 'app-server-daemon', 'app-server-updater.pid'),
      JSON.stringify({ pid: updaterPid, processStartTime: 'fixture' })
    );
    const running = new Set([updaterPid]);
    const terminated: number[] = [];
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      processExists: (pid) => running.has(pid),
      readManagedProcess: async (pid) => pid === updaterPid ? {
        arguments: [
          '/managed/codex', 'app-server', 'daemon', 'pid-update-loop'
        ],
        executable: join(
          fixture.environment.CODEX_HOME!,
          'packages', 'standalone', 'releases', '0.147.0', 'bin', 'codex'
        ),
        processStartTime: 'fixture'
      } : undefined,
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run,
      sleep: async () => undefined,
      terminateProcess: (pid) => {
        terminated.push(pid);
        running.delete(pid);
      }
    });

    const result = await manager.execute('ensure', 'doctor-repair-auto-update-drift');

    expect(result.evidence).toMatchObject({
      appServerVersion: '0.146.0',
      cliVersion: '0.146.0',
      compatible: true,
      state: 'ready'
    });
    expect(terminated).toEqual([updaterPid]);
    expect(fixture.commands).toContain('stop');
    expect(fixture.commands).toContain('enable-remote-control');
    expect(await realpath(join(
      fixture.environment.CODEX_HOME!, 'packages', 'standalone', 'current'
    ))).toContain('0.146.0-project-space-');
    await expect(manager.execute('status', 'doctor-stable-recheck')).resolves.toMatchObject({
      evidence: {
        appServerVersion: '0.146.0',
        cliVersion: '0.146.0',
        compatible: true,
        state: 'ready'
      },
      state: 'completed'
    });
    await fixture.close();
  });

  test('replaces a same-version managed binary that differs from the signed bundle', async () => {
    const fixture = await daemonFixture({ managedBinaryContents: 'different runtime\n' });
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.execute('ensure', 'doctor-replace-same-version-runtime'))
      .resolves.toMatchObject({ evidence: { compatible: true, state: 'ready' } });
    expect(fixture.commands).toContain('stop');
    expect(await Bun.file(join(
      fixture.environment.CODEX_HOME!, 'packages', 'standalone', 'current', 'codex'
    )).text()).toBe('#!/bin/sh\nexit 0\n');
    await fixture.close();
  });

  test('stops an exact orphaned managed app-server when lifecycle stop is unavailable', async () => {
    const fixture = await daemonFixture({
      initialAppServerVersion: '0.147.0',
      initialManagedCodexVersion: '0.147.0',
      managedBinaryLayout: 'packaged-symlink',
      stopFails: true
    });
    const appServerPid = 4_100_002;
    await mkdir(join(fixture.environment.CODEX_HOME!, 'app-server-daemon'), {
      recursive: true
    });
    await writeFile(
      join(fixture.environment.CODEX_HOME!, 'app-server-daemon', 'app-server.pid'),
      JSON.stringify({ pid: appServerPid, processStartTime: 'fixture' })
    );
    let running = true;
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      processExists: () => running,
      readManagedProcess: async (pid) => pid === appServerPid ? {
        arguments: [
          '/managed/codex', 'app-server', '--remote-control', '--listen', 'unix://'
        ],
        executable: join(
          fixture.environment.CODEX_HOME!,
          'packages', 'standalone', 'releases', '0.147.0', 'bin', 'codex'
        ),
        processStartTime: 'fixture'
      } : undefined,
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run,
      sleep: async () => undefined,
      terminateProcess: () => {
        running = false;
      }
    });

    const result = await manager.execute('ensure', 'doctor-repair-orphan');

    expect(result.evidence).toMatchObject({ compatible: true, state: 'ready' });
    expect(running).toBe(false);
    expect(fixture.commands.filter((command) => command === 'stop')).toHaveLength(1);
    await fixture.close();
  });

  test('refuses to terminate an updater process outside the managed package tree', async () => {
    const fixture = await daemonFixture({
      initialAppServerVersion: '0.147.0',
      initialManagedCodexVersion: '0.147.0'
    });
    const updaterPid = 4_100_003;
    await mkdir(join(fixture.environment.CODEX_HOME!, 'app-server-daemon'), {
      recursive: true
    });
    await writeFile(
      join(fixture.environment.CODEX_HOME!, 'app-server-daemon', 'app-server-updater.pid'),
      JSON.stringify({ pid: updaterPid, processStartTime: 'fixture' })
    );
    let terminated = false;
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      readManagedProcess: async () => ({
        arguments: ['/usr/bin/codex', 'app-server', 'daemon', 'pid-update-loop'],
        executable: '/usr/bin/codex',
        processStartTime: 'fixture'
      }),
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run,
      terminateProcess: () => {
        terminated = true;
      }
    });

    await expect(manager.execute('ensure', 'doctor-refuse-unrelated-updater'))
      .rejects.toThrow('outside the managed Codex package tree');
    expect(terminated).toBe(false);
    await fixture.close();
  });

  test('repairs drift safely when updater PID metadata is stale', async () => {
    const fixture = await daemonFixture({
      initialAppServerVersion: '0.147.0',
      initialManagedCodexVersion: '0.147.0'
    });
    await mkdir(join(fixture.environment.CODEX_HOME!, 'app-server-daemon'), {
      recursive: true
    });
    await writeFile(
      join(fixture.environment.CODEX_HOME!, 'app-server-daemon', 'app-server-updater.pid'),
      JSON.stringify({ pid: 4_100_004, processStartTime: 'stale fixture' })
    );
    let terminated = false;
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      readManagedProcess: async () => undefined,
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run,
      terminateProcess: () => {
        terminated = true;
      }
    });

    await expect(manager.execute('ensure', 'doctor-stale-updater-pid')).resolves.toMatchObject({
      evidence: { compatible: true, state: 'ready' }
    });
    expect(terminated).toBe(false);
    await fixture.close();
  });

  test('refuses to terminate a managed process after PID reuse', async () => {
    const fixture = await daemonFixture({
      initialAppServerVersion: '0.147.0',
      initialManagedCodexVersion: '0.147.0'
    });
    await mkdir(join(fixture.environment.CODEX_HOME!, 'app-server-daemon'), {
      recursive: true
    });
    await writeFile(
      join(fixture.environment.CODEX_HOME!, 'app-server-daemon', 'app-server-updater.pid'),
      JSON.stringify({ pid: 4_100_005, processStartTime: 'old fixture' })
    );
    let terminated = false;
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      readManagedProcess: async () => ({
        arguments: ['/managed/codex', 'app-server', 'daemon', 'pid-update-loop'],
        executable: join(
          fixture.environment.CODEX_HOME!,
          'packages', 'standalone', 'releases', '0.147.0', 'bin', 'codex'
        ),
        processStartTime: 'new fixture'
      }),
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run,
      terminateProcess: () => {
        terminated = true;
      }
    });

    await expect(manager.execute('ensure', 'doctor-refuse-reused-pid'))
      .rejects.toThrow('reused PID');
    expect(terminated).toBe(false);
    await fixture.close();
  });

  test('rolls the managed runtime pointer back when daemon activation fails', async () => {
    const fixture = await daemonFixture({
      failCommand: 'enable-remote-control',
      initialAppServerVersion: '0.147.0',
      initialManagedCodexVersion: '0.147.0',
      managedBinaryLayout: 'packaged-symlink'
    });
    const current = join(
      fixture.environment.CODEX_HOME!, 'packages', 'standalone', 'current'
    );
    const previousRelease = await realpath(current);
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run
    });

    await expect(manager.execute('ensure', 'doctor-rollback-failed-activation'))
      .rejects.toThrow('enable-remote-control operation could not be confirmed');
    expect(await realpath(current)).toBe(previousRelease);
    expect(fixture.commands.filter((command) => command === 'stop')).toHaveLength(2);
    await fixture.close();
  });

  test('bounds post-repair readiness verification and rolls back on timeout', async () => {
    const fixture = await daemonFixture({
      emitRemoteStatus: false,
      initialAppServerVersion: '0.147.0',
      initialManagedCodexVersion: '0.147.0',
      managedBinaryLayout: 'packaged-symlink'
    });
    const current = join(
      fixture.environment.CODEX_HOME!, 'packages', 'standalone', 'current'
    );
    const previousRelease = await realpath(current);
    let sleepCount = 0;
    const manager = new CodexDaemonManager({
      environment: fixture.environment,
      manager: {
        executeManagedOperation: async (_operationId, _fingerprint, action) => action()
      },
      resolveBinary: () => fixture.binaryPath,
      run: fixture.run,
      sleep: async () => {
        sleepCount++;
      }
    });

    await expect(manager.execute('ensure', 'doctor-bounded-readiness'))
      .rejects.toThrow('readiness was not established before the repair timeout');
    expect(sleepCount).toBe(9);
    expect(fixture.connectionCount()).toBe(10);
    expect(await realpath(current)).toBe(previousRelease);
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
  failCommand?: string;
  ignoreInitialize?: boolean;
  initialAppServerVersion?: string;
  initialManagedCodexVersion?: string;
  installSource?: string;
  managedBinary?: boolean;
  managedBinaryContents?: string;
  managedBinaryLayout?: 'direct' | 'external-symlink' | 'packaged-symlink';
  managedBinaryMode?: number;
  remoteControlEnabled?: boolean;
  stopFails?: boolean;
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
      await writeFile(managed, options.managedBinaryContents ?? '#!/bin/sh\nexit 0\n');
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
      await writeFile(managed, options.managedBinaryContents ?? '#!/bin/sh\nexit 0\n');
      await chmod(managed, options.managedBinaryMode ?? 0o755);
    }
  }

  const threads = new Map<string, Record<string, unknown>>();
  let connectionCount = 0;
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
          updatedAt: 1
        };
        threads.set(thread.id, thread);
        result = { thread };
      } else if (request.method === 'thread/list') {
        result = { data: [...threads.values()], nextCursor: null };
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
  let managedCodexVersion = options.initialManagedCodexVersion ?? '0.146.0';
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
      if ((command === 'stop' && options.stopFails) || command === options.failCommand) {
        return { exitCode: 1, stdout: '' };
      }
      if (command === 'start' || command === 'restart') {
        appServerVersion = '0.146.0';
        managedCodexVersion = '0.146.0';
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          appServerVersion,
          ...('backend' in options ? { backend: options.backend } : { backend: 'pid' }),
          cliVersion: '0.146.0',
          managedCodexVersion,
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
    connectionCount: () => connectionCount,
    environment,
    maximumConcurrentCommands: () => maximumConcurrentCommands,
    run,
    socketPath
  };
}
