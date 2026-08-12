import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { describe, expect, test } from 'bun:test';
import { WebSocketServer, type WebSocket as ServerWebSocket } from 'ws';

import { connectorRuntimeRecord } from '../server/connector-build-info';
import {
  connectorRuntimeStopBinding,
  connectorRuntimeStopSchema,
  createConnectorRuntimeStopWireRequest
} from '../server/connector-runtime-stop-contract';
import { connectorRuntimeReleaseTarget } from '../server/connector-runtime-maintenance-contract';
import {
  connectorRuntimeCredentialVersion,
  connectorRuntimeProtocolEnvironment
} from '../server/connector-runtime-credential';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';
import {
  readAndStartAuthenticatedProjectConnectorRuntime,
  startAuthenticatedProjectConnectorRuntime
} from '../server/project-connector-runtime';
import { startProjectConnectorWebSocket } from '../server/project-connector-websocket';
import type {
  ConnectorProjectRegistryResult,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';

type PublishedRegistryMessage = {
  payload: ConnectorProjectRegistryResult;
  token?: string;
  type: 'connector.register' | 'connector.registry';
};

const runtimeCredential = {
  backendUrl: '',
  credential: 'runtime-only-machine-token',
  machineId: 'authenticated-runtime-machine',
  version: connectorRuntimeCredentialVersion
};

async function waitFor(assertion: () => boolean, description: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function createRecordingConnectorHub(acknowledgeRegistrations = true) {
  const messages: PublishedRegistryMessage[] = [];
  const received: Array<{
    message: PublishedRegistryMessage;
    socket: ServerWebSocket;
  }> = [];
  const sockets: ServerWebSocket[] = [];
  const connections = new Set<Socket>();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const httpServer = createServer((_request, response) => {
    response.writeHead(204).end();
  });

  httpServer.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/connectors/socket') {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit('connection', client, request);
    });
  });
  webSocketServer.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as PublishedRegistryMessage;
      messages.push(message);
      received.push({ message, socket });
      if (acknowledgeRegistrations && message.type === 'connector.register') {
        socket.send(JSON.stringify({ generation: 1, type: 'connector.registered' }));
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address() as AddressInfo;

  return {
    messages,
    origin: `http://127.0.0.1:${address.port}`,
    received,
    sockets,
    async close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      for (const connection of connections) {
        connection.destroy();
      }
      webSocketServer.close();
      httpServer.close();
    }
  };
}

function runtimeBackend(
  runtime?: ReturnType<typeof connectorRuntimeRecord>
) {
  const registry: ConnectorProjectRegistryResult = {
    checkedAt: new Date().toISOString(),
    connector: {
      machineId: 'poisoned-registry-machine',
      machineName: 'Authenticated runtime test',
      ...(runtime ? { runtime } : {})
    },
    discovery: {
      groups: [],
      projects: [
        {
          id: 'runtime-project',
          kind: 'standalone',
          machineId: 'poisoned-registry-machine',
          name: 'Runtime project',
          rootPath: '/tmp/runtime-project'
        }
      ],
      rootItems: [],
      rootPath: '/tmp',
      structureViolations: []
    }
  };
  return {
    async getConnectorProjectRegistry() {
      return structuredClone(registry);
    }
  } as unknown as ProjectSpaceBackend;
}

describe('authenticated connector companion runtime', () => {
  test('advertises only source stop and acknowledges it before source shutdown', async () => {
    if (process.platform === 'win32') return;
    const hub = await createRecordingConnectorHub(false);
    const keys = generateKeyPairSync('ed25519');
    const originalSigningKey = process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY;
    process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY = keys.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const runtime = connectorRuntimeRecord({
      PROJECT_SPACE_BUILD_ID: 'b'.repeat(40),
      PROJECT_SPACE_INSTALL_SOURCE: 'source',
      PROJECT_SPACE_RELEASE_CHANNEL: 'dev',
      PROJECT_SPACE_RELEASE_ID: `dev-source-${'b'.repeat(40)}`
    });
    const target = connectorRuntimeReleaseTarget(runtime.platform, runtime.architecture);
    if (!target || target === 'windows-x64') throw new Error('Expected source stop target.');
    const sourceBackend = runtimeBackend(runtime);
    const loadRegistry = sourceBackend.getConnectorProjectRegistry.bind(sourceBackend);
    sourceBackend.getConnectorProjectRegistry = async () => {
      const registry = await loadRegistry();
      registry.connector.capabilities = [
        'runtime.restart',
        'runtime.stop',
        'runtime.update'
      ];
      return registry;
    };
    const events: string[] = [];
    const credential = { ...runtimeCredential, backendUrl: hub.origin };
    const bridge = startProjectConnectorWebSocket({
      backend: sourceBackend,
      reconnectDelayMs: 10,
      registryIntervalMs: 1_000,
      runtimeCredential: credential,
      runtimeShutdown() {
        events.push('shutdown');
      }
    });

    try {
      await waitFor(
        () => hub.messages.some((message) => message.type === 'connector.register'),
        'the source connector registration'
      );
      const registration = hub.messages.find(
        (message) => message.type === 'connector.register'
      );
      expect(registration?.payload.connector.capabilities).toEqual(['runtime.stop']);

      hub.sockets[0]?.send(JSON.stringify({ generation: 7, type: 'connector.registered' }));
      const request = createConnectorRuntimeStopWireRequest(
        {
          generation: 7,
          plan: {
            expectedRuntime: {
              buildId: runtime.buildId,
              channel: 'dev',
              instanceId: runtime.instanceId,
              protocolVersion: runtime.protocolVersion,
              releaseId: runtime.releaseId,
              source: 'source'
            },
            machineId: credential.machineId,
            operation: 'stop',
            operationId: 'source-stop-integration',
            schema: connectorRuntimeStopSchema,
            target
          },
          userId: 'user-owner'
        },
        keys.privateKey,
        { nonce: 'source-stop-integration' }
      );
      hub.sockets[0]?.send(JSON.stringify({
        id: 'source-stop-message',
        payload: request,
        type: 'runtime.stop'
      }));

      await waitFor(() => events.includes('shutdown'), 'the source runtime shutdown');
      await waitFor(
        () => hub.messages.some(
          (message) => (message as { type: string }).type === 'runtime.stop.result'
        ),
        'the source runtime stop acknowledgement'
      );
      const result = hub.messages.find(
        (message) => (message as { type: string }).type === 'runtime.stop.result'
      ) as unknown as {
        id: string;
        payload: { binding: ReturnType<typeof connectorRuntimeStopBinding>; status: string };
        type: string;
      } | undefined;
      expect(result).toEqual({
        id: 'source-stop-message',
        payload: {
          binding: connectorRuntimeStopBinding(request),
          status: 'accepted'
        },
        type: 'runtime.stop.result'
      });
      expect(events).toEqual(['shutdown']);
    } finally {
      bridge.close();
      if (originalSigningKey === undefined) {
        delete process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY;
      } else {
        process.env.PROJECT_CONNECTOR_COMMAND_SIGNING_PUBLIC_KEY = originalSigningKey;
      }
      await hub.close();
    }
  }, 15_000);

  test('uses only stdin identity, publishes only over WebSocket, and reconnects until closed', async () => {
    const hub = await createRecordingConnectorHub();
    const scratch = mkdtempSync(join(tmpdir(), 'project-connector-runtime-'));
    const configPath = join(scratch, 'connector.json');
    const environmentNames = [
      'PROJECT_CONNECTOR_CONFIG',
      'PROJECT_CONNECTOR_HUBS',
      'PROJECT_CONNECTOR_HUB_URL',
      'PROJECT_CONNECTOR_HUB_WS_URL',
      'PROJECT_CONNECTOR_MACHINE_ID',
      'PROJECT_CONNECTOR_REGISTRATION_TOKEN'
    ] as const;
    const originalEnvironment = new Map(
      environmentNames.map((name) => [name, process.env[name]])
    );
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings: string[] = [];
    let fetchCalls = 0;
    let bridge: { close(): void } | null = null;

    writeFileSync(
      configPath,
      JSON.stringify({
        hubs: [{ name: 'poison-config', url: hub.origin }],
        machineId: 'poison-config-machine'
      })
    );
    process.env.PROJECT_CONNECTOR_CONFIG = configPath;
    process.env.PROJECT_CONNECTOR_HUBS = `poison-env=${hub.origin}`;
    process.env.PROJECT_CONNECTOR_HUB_URL = hub.origin;
    process.env.PROJECT_CONNECTOR_HUB_WS_URL = hub.origin.replace(/^http/, 'ws');
    process.env.PROJECT_CONNECTOR_MACHINE_ID = 'poison-env-machine';
    process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN = 'poison-env-token';
    globalThis.fetch = (async (...arguments_: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return originalFetch(...arguments_);
    }) as typeof fetch;
    console.warn = (...values: unknown[]) => warnings.push(values.map(String).join(' '));

    try {
      const credential = { ...runtimeCredential, backendUrl: hub.origin };
      bridge = await readAndStartAuthenticatedProjectConnectorRuntime({
        backend: runtimeBackend(),
        environment: {
          [connectorRuntimeProtocolEnvironment]: connectorRuntimeCredentialVersion
        },
        input: Readable.from([JSON.stringify(credential)]),
        reconnectDelayMs: 10,
        registryIntervalMs: 15
      });
      expect(bridge).not.toBeNull();

      await waitFor(
        () => hub.messages.some((message) => message.type === 'connector.registry'),
        'the periodic registry publication'
      );
      expect(hub.sockets).toHaveLength(1);
      expect(fetchCalls).toBe(0);
      for (const message of hub.messages) {
        expect(message.payload.connector.machineId).toBe(credential.machineId);
        expect(message.payload.discovery.projects[0]?.machineId).toBe(
          credential.machineId
        );
      }
      const firstRegistration = hub.messages.find(
        (message) => message.type === 'connector.register'
      );
      expect(firstRegistration?.token).toBe(credential.credential);
      expect(firstRegistration?.token).not.toBe(process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN);

      hub.sockets[0]?.close(1012, 'Reconnect test');
      await waitFor(
        () =>
          hub.sockets.length === 2 &&
          hub.messages.filter((message) => message.type === 'connector.register').length >= 2,
        'the authenticated connector reconnect'
      );
      for (const registration of hub.messages.filter(
        (message) => message.type === 'connector.register'
      )) {
        expect(registration.token).toBe(credential.credential);
        expect(registration.payload.connector.machineId).toBe(credential.machineId);
      }

      bridge?.close();
      const connectionsAfterClose = hub.sockets.length;
      await waitFor(
        () => hub.sockets.every((socket) => socket.readyState === 3),
        'all connector sockets to close'
      );
      await Bun.sleep(60);
      expect(hub.sockets).toHaveLength(connectionsAfterClose);
      expect(fetchCalls).toBe(0);
      expect(process.argv).not.toContain(credential.credential);
      expect(warnings.join('\n')).not.toContain(credential.credential);
    } finally {
      bridge?.close();
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
      rmSync(scratch, { force: true, recursive: true });
      await hub.close();
    }
  }, 15_000);

  test('starts periodic registry publication only after registration is acknowledged', async () => {
    const hub = await createRecordingConnectorHub(false);
    const bridge = await startAuthenticatedProjectConnectorRuntime({
      backend: runtimeBackend(),
      credential: { ...runtimeCredential, backendUrl: hub.origin },
      reconnectDelayMs: 10,
      registryIntervalMs: 10
    });

    try {
      await waitFor(
        () => hub.messages.some((message) => message.type === 'connector.register'),
        'the initial connector registration'
      );
      await Bun.sleep(50);
      expect(hub.messages.some((message) => message.type === 'connector.registry')).toBe(false);

      hub.sockets[0]?.send(JSON.stringify({ generation: 1, type: 'connector.registered' }));
      await waitFor(
        () => hub.messages.some((message) => message.type === 'connector.registry'),
        'registry publication after registration acknowledgement'
      );
    } finally {
      bridge.close();
      await hub.close();
    }
  }, 15_000);

  test('publishes exact local readiness only after authenticated registration acknowledgement', async () => {
    const hub = await createRecordingConnectorHub(false);
    const scratch = mkdtempSync(join(tmpdir(), 'project-connector-ready-'));
    const readyPath = join(scratch, 'connector-ready.json');
    const environmentNames = [
      'PROJECT_CONNECTOR_READY_FILE',
      'PROJECT_CONNECTOR_READY_ATTEMPT_NONCE',
      'PROJECT_SPACE_BUILD_ID',
      'PROJECT_SPACE_RELEASE_ID'
    ] as const;
    const originalEnvironment = new Map(
      environmentNames.map((name) => [name, process.env[name]])
    );
    process.env.PROJECT_CONNECTOR_READY_FILE = readyPath;
    process.env.PROJECT_CONNECTOR_READY_ATTEMPT_NONCE = '1'.repeat(64);
    process.env.PROJECT_SPACE_BUILD_ID = 'a'.repeat(40);
    process.env.PROJECT_SPACE_RELEASE_ID = 'v0.4.1';
    const credential = { ...runtimeCredential, backendUrl: hub.origin };
    let bridge: Awaited<ReturnType<typeof startAuthenticatedProjectConnectorRuntime>> | undefined;

    try {
      bridge = await startAuthenticatedProjectConnectorRuntime({
        backend: runtimeBackend(connectorRuntimeRecord()),
        credential,
        reconnectDelayMs: 10,
        registryIntervalMs: 10
      });
      await waitFor(
        () => hub.received.some(({ message }) => message.type === 'connector.register'),
        'the readiness registration'
      );
      expect(existsSync(readyPath)).toBe(false);

      const registration = hub.received.find(
        ({ message }) => message.type === 'connector.register'
      );
      registration?.socket.send(
        JSON.stringify({ generation: 1, type: 'connector.registered' })
      );
      await waitFor(() => existsSync(readyPath), 'the authenticated readiness proof');
      expect(JSON.parse(readFileSync(readyPath, 'utf8'))).toEqual({
        schema: 'project-space.connector-runtime-ready/v2',
        machineId: credential.machineId,
        buildId: 'a'.repeat(40),
        releaseId: 'v0.4.1',
        attemptNonce: '1'.repeat(64)
      });
    } finally {
      bridge?.close();
      for (const [name, value] of originalEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(scratch, { force: true, recursive: true });
      await hub.close();
    }
  }, 15_000);

  test('never publishes a slow registry read from an obsolete socket onto a reconnect', async () => {
    const hub = await createRecordingConnectorHub();
    const firstRegistry = deferred<ConnectorProjectRegistryResult>();
    const registry = await runtimeBackend().getConnectorProjectRegistry();
    let registryReads = 0;
    const backend = {
      async getConnectorProjectRegistry() {
        registryReads += 1;
        return registryReads === 1 ? firstRegistry.promise : structuredClone(registry);
      }
    } as unknown as ProjectSpaceBackend;
    const bridge = await startAuthenticatedProjectConnectorRuntime({
      backend,
      credential: { ...runtimeCredential, backendUrl: hub.origin },
      reconnectDelayMs: 10,
      registryIntervalMs: 1_000
    });

    try {
      await waitFor(
        () => hub.sockets.length === 1 && registryReads === 1,
        'the first slow registry read'
      );
      hub.sockets[0]?.close(1012, 'Replace slow connection');
      await waitFor(
        () =>
          hub.sockets.length === 2 &&
          hub.received.some(
            ({ message, socket }) =>
              socket === hub.sockets[1] && message.type === 'connector.register'
          ),
        'the replacement connector registration'
      );

      firstRegistry.resolve(structuredClone(registry));
      await Bun.sleep(50);
      expect(
        hub.received.filter(
          ({ message, socket }) =>
            socket === hub.sockets[1] && message.type === 'connector.register'
        )
      ).toHaveLength(1);
    } finally {
      bridge.close();
      firstRegistry.resolve(structuredClone(registry));
      await hub.close();
    }
  }, 15_000);

  test('does not start a bridge or consume legacy state outside supervisor mode', async () => {
    let registryReads = 0;
    const backend = {
      async getConnectorProjectRegistry() {
        registryReads += 1;
        return runtimeBackend().getConnectorProjectRegistry();
      }
    } as unknown as ProjectSpaceBackend;

    await expect(
      readAndStartAuthenticatedProjectConnectorRuntime({
        backend,
        environment: {},
        input: Readable.from(['not a runtime credential'])
      })
    ).resolves.toBeNull();
    expect(registryReads).toBe(0);
  });

  test('reuses strict runtime credential validation for direct callers', async () => {
    const unsafeCredential = {
      ...runtimeCredential,
      backendUrl: 'http://remote.example.test'
    };
    try {
      await startAuthenticatedProjectConnectorRuntime({
        backend: runtimeBackend(),
        credential: unsafeCredential
      });
      throw new Error('Expected the unsafe runtime target to fail.');
    } catch (error) {
      expect(String(error)).toContain('runtime credential is invalid');
      expect(String(error)).not.toContain(unsafeCredential.credential);
    }
  });

  test('forces the authenticated machine identity in the local registry', async () => {
    const originalMachineId = process.env.PROJECT_CONNECTOR_MACHINE_ID;
    process.env.PROJECT_CONNECTOR_MACHINE_ID = ' invalid legacy machine id ';
    try {
      const backend = createLocalProjectSpaceBackend({
        connectorMachineId: runtimeCredential.machineId,
        connectorMachineName: 'project-space--537-reliable-runner'
      });
      const registry = await backend.getConnectorProjectRegistry();
      expect(registry.connector.machineId).toBe(runtimeCredential.machineId);
      expect(registry.connector.machineName).toBe('project-space--537-reliable-runner');
      expect(registry.connector.capabilities).toContain('dev-server.list');
      expect(
        registry.discovery.projects.every(
          (project) => project.machineId === runtimeCredential.machineId
        )
      ).toBe(true);

      const filesystemRoot = await backend.getMachineFileSystemRoot({
        machineId: runtimeCredential.machineId
      });
      expect(filesystemRoot.status).toBe('success');
      const directory = await backend.readMachineDirectory({
        machineId: runtimeCredential.machineId,
        path: homedir()
      });
      expect(directory.status).toBe('success');

      if (process.platform !== 'win32') {
        const command = await backend.runMachineTerminalCommand({
          command: 'printf authenticated-runtime-command',
          machineId: runtimeCredential.machineId
        });
        expect(command.exitCode).toBe(0);
        expect(command.stdout).toBe('authenticated-runtime-command');
      }

      const wrongMachine = await backend.getMachineFileSystemRoot({
        machineId: 'different-machine'
      });
      expect(wrongMachine.status).toBe('error');
    } finally {
      if (originalMachineId === undefined) {
        delete process.env.PROJECT_CONNECTOR_MACHINE_ID;
      } else {
        process.env.PROJECT_CONNECTOR_MACHINE_ID = originalMachineId;
      }
    }
  }, 15_000);
});
