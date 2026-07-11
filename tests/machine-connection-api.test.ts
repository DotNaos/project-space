import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, test } from 'bun:test';

import { createMachineConnectionApiHandler } from '../server/machine-connection-api';
import { MemoryMachineConnectionStore } from '../server/machine-connection-memory-store';
import {
  MachineConnectionService,
  machineApprovalProofMessage
} from '../server/machine-connection-service';

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function startApi(allowCreateRequest = true) {
  const onlineMachines = new Map<string, string>();
  const store = new MemoryMachineConnectionStore();
  const service = new MachineConnectionService({
    isMachineOnline: (machineId, credential) =>
      onlineMachines.get(machineId) === credential,
    publicOrigin: 'https://projects.os-home.net',
    store
  });
  const handler = createMachineConnectionApiHandler({
    allowCreateRequest: async () => allowCreateRequest,
    readAuthenticatedUserId: async (request) =>
      request.headers.authorization === 'Bearer browser-session' ? 'user_oli' : null,
    service
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    void handler(request, response, url).then((handled) => {
      if (!handled) {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind.');
  const result = {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    origin: `http://127.0.0.1:${address.port}`,
    setOnline(machineId: string, credential?: string) {
      if (credential) onlineMachines.set(machineId, credential);
      else onlineMachines.delete(machineId);
    },
    service
  };
  servers.push(result);
  return result;
}

function machineKeys() {
  const pair = generateKeyPairSync('ed25519');
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  if (!publicJwk.x) throw new Error('Public key export failed.');
  return { privateKey: pair.privateKey, publicKey: publicJwk.x };
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

describe('machine connection API', () => {
  test('completes backend-mediated approval without exposing Clerk to the CLI', async () => {
    const api = await startApi();
    const keys = machineKeys();
    const createResponse = await fetch(`${api.origin}/api/machine-connections`, {
      body: JSON.stringify({
        architecture: 'amd64',
        clientVersion: '0.3.0',
        hostname: 'os-pc',
        name: 'os-pc-wsl',
        operatingSystem: 'linux',
        publicKey: keys.publicKey
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    const created = await json(createResponse);
    expect(createResponse.status).toBe(201);
    expect(created.approvalUrl).toBe(
      `https://projects.os-home.net/connector/connect?request=${created.requestId}`
    );

    const unauthenticatedApproval = await fetch(
      `${api.origin}/api/machine-connections/${created.requestId}/approve`,
      { method: 'POST' }
    );
    expect(unauthenticatedApproval.status).toBe(401);

    const approval = await fetch(
      `${api.origin}/api/machine-connections/${created.requestId}/approve`,
      { headers: { Authorization: 'Bearer browser-session' }, method: 'POST' }
    );
    expect(approval.status).toBe(200);

    const poll = await fetch(`${api.origin}/api/machine-connections/${created.requestId}`, {
      headers: { Authorization: `Bearer ${created.pollToken}` }
    });
    const approved = await json(poll);
    expect(approved.status).toBe('approved');

    const signature = sign(
      null,
      machineApprovalProofMessage(
        String(created.requestId),
        String(approved.approvalChallenge)
      ),
      keys.privateKey
    ).toString('base64url');
    const exchange = await fetch(
      `${api.origin}/api/machine-connections/${created.requestId}/exchange`,
      {
        body: JSON.stringify({ signature }),
        headers: {
          Authorization: `Bearer ${created.pollToken}`,
          'Content-Type': 'application/json'
        },
        method: 'POST'
      }
    );
    const machine = await json(exchange);
    expect(exchange.status).toBe(200);
    expect(machine.machineName).toBe('os-pc-wsl');

    await api.service.markMachineOnline(String(machine.machineId), String(machine.credential));
    api.setOnline(String(machine.machineId), String(machine.credential));
    const status = await fetch(
      `${api.origin}/api/machines/${machine.machineId}/connection`,
      { headers: { Authorization: `Bearer ${machine.credential}` } }
    );
    expect(await json(status)).toMatchObject({ status: 'online' });
  });

  test('bounds public request bodies', async () => {
    const api = await startApi();
    const response = await fetch(`${api.origin}/api/machine-connections`, {
      body: JSON.stringify({ padding: 'x'.repeat(40_000) }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: 'Request body is too large.' });
  });

  test('requires an external rate-limit decision before allocating a request', async () => {
    const api = await startApi(false);
    const response = await fetch(`${api.origin}/api/machine-connections`, {
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await json(response)).toMatchObject({
      error: 'Too many machine connection requests.'
    });
  });

  test('does not distinguish a missing request from an invalid polling secret', async () => {
    const api = await startApi();
    const keys = machineKeys();
    const createdResponse = await fetch(`${api.origin}/api/machine-connections`, {
      body: JSON.stringify({
        architecture: 'amd64',
        clientVersion: '0.3.0',
        hostname: 'os-pc',
        name: 'os-pc-wsl',
        operatingSystem: 'linux',
        publicKey: keys.publicKey
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });
    const created = await json(createdResponse);

    const wrongSecret = await fetch(
      `${api.origin}/api/machine-connections/${created.requestId}`,
      { headers: { Authorization: 'Bearer wrong-poll-secret' } }
    );
    const missing = await fetch(`${api.origin}/api/machine-connections/missing-request`, {
      headers: { Authorization: 'Bearer wrong-poll-secret' }
    });

    expect(wrongSecret.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await wrongSecret.text()).toBe(await missing.text());
  });
});
