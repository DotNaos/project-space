import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import {
  createConnectorCodexAttachRelay,
  type ConnectorCodexAttachRelayCloseCode
} from '../server/codex-machine-tasks/connector-attach-relay';
import type { CodexChildProcess } from '../server/codex-sessions/contracts';

const unixSocketFixtureRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();

class FakeAttachProcess extends EventEmitter implements CodexChildProcess {
  exitCode: number | null = null;
  readonly pid = 123;
  signalCode: NodeJS.Signals | null = null;
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly signals: Array<NodeJS.Signals | number> = [];

  kill(signal: NodeJS.Signals | number = 'SIGTERM') {
    this.signals.push(signal);
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    queueMicrotask(() => this.emit('close'));
    return true;
  }
}

describe('Codex connector attach stdio relay', () => {
  test('bounds a stalled shared-daemon handshake', async () => {
    const fixtureRoot = await mkdtemp(join(unixSocketFixtureRoot, 'ps-attach-stalled-'));
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
    try {
      const startedAt = Date.now();
      await expect(createConnectorCodexAttachRelay({
        connectTimeoutMs: 20,
        daemonSocketPath: socketPath,
        onClose: () => undefined,
        onMessage: () => undefined
      })).rejects.toThrow('unavailable');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });

  test('launches a private stdio App Server and relays bounded JSON messages', async () => {
    const child = new FakeAttachProcess();
    const output: string[] = [];
    const closed: ConnectorCodexAttachRelayCloseCode[] = [];
    let launch: { args: readonly string[]; command: string; env: NodeJS.ProcessEnv } | undefined;
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk.toString(); });
    const relay = await createConnectorCodexAttachRelay({
      binaryPath: '/working/codex',
      onClose: (code) => closed.push(code),
      onMessage: (message) => output.push(message),
      processFactory: (options) => {
        launch = options;
        return child;
      }
    });

    expect(launch?.command).toBe('/working/codex');
    expect(launch?.args).toEqual(['app-server', '--listen', 'stdio://']);
    expect(JSON.stringify(launch?.args)).not.toContain('token');
    expect(launch?.env.PROJECT_CODEX_ATTACH_TOKEN).toBeUndefined();
    await relay.send('{"id":1,"method":"initialize"}');
    expect(input).toBe('{"id":1,"method":"initialize"}\n');

    child.stdout.write('{"id":1,"res');
    child.stdout.write('ult":{}}\n{"method":"turn/started"}\n');
    await Bun.sleep(0);
    expect(output).toEqual(['{"id":1,"result":{}}', '{"method":"turn/started"}']);
    relay.close();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(closed).toEqual(['cancelled']);
  });

  test('fails closed on malformed input, malformed output, and idle expiry', async () => {
    for (const scenario of ['input', 'output', 'idle'] as const) {
      const child = new FakeAttachProcess();
      const closed: ConnectorCodexAttachRelayCloseCode[] = [];
      const relay = await createConnectorCodexAttachRelay({
        binaryPath: '/working/codex',
        idleTimeoutMs: scenario === 'idle' ? 5 : 10_000,
        onClose: (code) => closed.push(code),
        onMessage: () => {},
        processFactory: () => child
      });
      if (scenario === 'input') {
        await expect(relay.send('not-json')).rejects.toThrow();
      } else if (scenario === 'output') {
        child.stdout.write('not-json\n');
      } else {
        await Bun.sleep(15);
      }
      await Bun.sleep(0);
      expect(closed).toEqual([scenario === 'idle' ? 'cancelled' : 'protocol_error']);
      expect(child.signals).toContain('SIGTERM');
    }
  });
});
