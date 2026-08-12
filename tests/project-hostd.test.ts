import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';

import { MemoryProjectHostdStore } from '../server/project-hostd/memory-store';
import { ProjectHostdError } from '../server/project-hostd/contracts';
import { ProjectHostdService } from '../server/project-hostd/service';
import { parseObservation } from '../server/project-hostd/validation';
import { createProjectHostdHttpApi } from '../server/project-hostd/http';
import { CodexMachineTasksAuthError } from '../server/codex-machine-tasks/auth-context';

const ownerUserId = 'owner-one';
const deviceId = '10000000-0000-4000-8000-000000000001';
const environmentId = '20000000-0000-4000-8000-000000000001';
const hostId = '30000000-0000-4000-8000-000000000001';
const workspaceId = '40000000-0000-4000-8000-000000000001';
const generation = '50000000-0000-4000-8000-000000000001';
const credentialId = '60000000-0000-4000-8000-000000000001';
const token = 'A'.repeat(43);

function observation(overrides: Record<string, unknown> = {}) {
  return {
    deviceId,
    environmentId,
    health: 'healthy',
    hostId,
    hostdVersion: '0.1.0',
    observationId: 'observation-one',
    observedAt: '2026-08-12T10:00:00.000Z',
    partialMetrics: [],
    protocolVersion: 1,
    resources: {
      architecture: 'arm64',
      cpu: { cores: 10, usedPercent: 14.5 },
      memory: { availableBytes: 16_000, totalBytes: 32_000 },
      operatingSystem: 'macOS 27.0',
      storage: { availableBytes: 500_000, totalBytes: 1_000_000 }
    },
    runtimes: [],
    schemaVersion: 1,
    sequence: 1,
    type: 'hostd.telemetry',
    uptimeSeconds: 42,
    ...overrides
  };
}

function setup(now = new Date('2026-08-12T10:00:01.000Z')) {
  const store = new MemoryProjectHostdStore(() => now, () => credentialId, () => token);
  const service = new ProjectHostdService(store, {
    async resolve(input) {
      return input.environmentId === environmentId && input.hostId === hostId ? 'matched' : 'conflict';
    }
  }, {
    async registered(input) {
      return input.runtimes.every((runtime) =>
        runtime.workspaceId === workspaceId && runtime.generation === generation
      );
    }
  }, () => now);
  return { service, store };
}

async function issue(service: ProjectHostdService, operationId = 'issue-one') {
  return service.issue({ deviceId, environmentId, hostId, operationId, ownerUserId });
}

describe('project-hostd telemetry boundary', () => {
  test('issues a target-bound credential and never accepts it after replacement or revocation', async () => {
    const { service, store } = setup();
    const first = await issue(service);
    expect(first).toEqual({ credentialId, deviceId, environmentId,
      expiresAt: '2026-09-11T10:00:01.000Z', hostId, schemaVersion: 1, token });
    expect(await service.authenticate(token)).toMatchObject({
      credentialId, deviceId, environmentId, hostId, ownerUserId
    });
    await store.revoke(ownerUserId, deviceId, credentialId);
    expect(await service.authenticate(token)).toBeNull();
    await expect(issue(service, 'issue-two')).resolves.toMatchObject({ deviceId, environmentId });
    await expect(service.issue({
      deviceId, environmentId: '20000000-0000-4000-8000-000000000002',
      operationId: 'changed-target', ownerUserId
    })).rejects.toMatchObject({ code: 'target_conflict' });
  });

  test('accepts partial measurements, replays exactly, and fences changed sequence or payload', async () => {
    const { service } = setup();
    await issue(service);
    const scope = await service.authenticate(token);
    if (!scope) throw new Error('missing scope');
    const message = observation({ health: 'degraded', partialMetrics: ['gpu'] });
    const accepted = await service.append(scope, message);
    expect(accepted.replayed).toBe(false);
    expect(accepted.snapshot).toMatchObject({
      connectionState: 'online', health: 'degraded', partialMetrics: ['gpu'], sequence: 1
    });
    expect((await service.append(scope, message)).replayed).toBe(true);
    await expect(service.append(scope, observation({ observationId: 'changed', sequence: 1 })))
      .rejects.toMatchObject({ code: 'replay_conflict' });
    await expect(service.append(scope, observation({ observationId: 'gap', sequence: 3 })))
      .rejects.toMatchObject({ code: 'sequence_conflict' });
  });

  test('accepts an exact old replay but rejects a new stale observation', async () => {
    let now = new Date('2026-08-12T10:00:01.000Z');
    const { service, store } = setup(now);
    await issue(service);
    const scope = await service.authenticate(token);
    if (!scope) throw new Error('missing scope');
    const first = observation();
    await service.append(scope, first);

    now = new Date('2026-08-12T10:10:01.000Z');
    const later = new ProjectHostdService(
      store,
      { async resolve() { return 'matched'; } },
      { async registered() { return true; } },
      () => now
    );
    await expect(later.append(scope, first)).resolves.toMatchObject({ replayed: true });
    await expect(later.append(scope, observation({
      observationId: 'new-but-stale', sequence: 2
    }))).rejects.toMatchObject({ code: 'stale_observation' });
  });

  test('revokes observation authority when the current compute target changes', async () => {
    let target: 'matched' | 'conflict' = 'matched';
    const store = new MemoryProjectHostdStore(
      () => new Date('2026-08-12T10:00:01.000Z'), () => credentialId, () => token
    );
    const service = new ProjectHostdService(store, {
      async resolve() { return target; }
    }, { async registered() { return true; } },
    () => new Date('2026-08-12T10:00:01.000Z'));
    await issue(service);
    const scope = await service.authenticate(token);
    if (!scope) throw new Error('missing scope');
    target = 'conflict';
    await expect(service.append(scope, observation()))
      .rejects.toMatchObject({ code: 'target_conflict' });
    expect(await service.list(ownerUserId)).toEqual([]);
  });

  test('requires degraded health for partial evidence and retains the latest replay proof', async () => {
    const { service, store } = setup();
    expect(() => parseObservation(observation({ partialMetrics: ['memory'] })))
      .toThrow(ProjectHostdError);
    await issue(service);
    const scope = await service.authenticate(token);
    if (!scope) throw new Error('missing scope');
    const first = observation();
    await service.append(scope, first);
    expect(await store.pruneExpired('2026-08-13T10:00:00.000Z')).toBe(0);
    await expect(service.append(scope, first)).resolves.toMatchObject({ replayed: true });
  });

  test('rejects unregistered runtime attribution before persistence', async () => {
    const { service } = setup();
    await issue(service);
    const scope = await service.authenticate(token);
    if (!scope) throw new Error('missing scope');
    await expect(service.append(scope, observation({ runtimes: [{
      boundaryKind: 'process_group', cpuPercent: 5, generation,
      memoryBytes: 1024, workspaceId: '40000000-0000-4000-8000-000000000099'
    }] }))).rejects.toMatchObject({ code: 'unregistered_runtime' });
    expect(await service.list(ownerUserId)).toEqual([]);
  });

  test('marks disconnected telemetry stale without rewriting the last evidence time', async () => {
    let now = new Date('2026-08-12T10:00:01.000Z');
    const store = new MemoryProjectHostdStore(() => now, () => credentialId, () => token);
    const service = new ProjectHostdService(store, { async resolve() { return 'matched'; } },
      { async registered() { return true; } }, () => now);
    await issue(service);
    const scope = await service.authenticate(token);
    if (!scope) throw new Error('missing scope');
    await service.append(scope, observation());
    now = new Date('2026-08-12T10:02:00.000Z');
    const stale = await service.expireStale();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ connectionState: 'stale', lastSeenAt: '2026-08-12T10:00:01.000Z' });
  });

  test('strictly rejects unknown fields and unsafe metric values', () => {
    expect(() => parseObservation(observation({ privateAddress: '100.64.0.10' })))
      .toThrow(ProjectHostdError);
    expect(() => parseObservation(observation({
      resources: { ...observation().resources as object, cpu: { cores: 10, usedPercent: 101 } }
    }))).toThrow(ProjectHostdError);
  });

  test('keeps provisioning authority separate from the outbound device credential', async () => {
    const { service } = setup();
    const handler = createProjectHostdHttpApi(service, async (request) => {
      if (request.headers.authorization !== 'Bearer machine-admin') {
        throw new CodexMachineTasksAuthError(401);
      }
      return { userId: ownerUserId };
    });
    const server = createServer(async (request, response) => {
      const handled = await handler(request, response,
        new URL(request.url ?? '/', 'http://127.0.0.1'));
      if (!handled) response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const provisioned = await fetch(`${origin}/api/compute/hostd/credentials`, {
        method: 'POST', headers: {
          Authorization: 'Bearer machine-admin', 'Content-Type': 'application/json'
        },
        body: JSON.stringify({ deviceId, environmentId, hostId, operationId: 'http-issue' })
      });
      expect(provisioned.status).toBe(201);
      expect(provisioned.headers.get('cache-control')).toBe('private, no-store');
      const credential = await provisioned.json() as { token: string };

      const accepted = await fetch(`${origin}/api/compute/hostd/telemetry`, {
        method: 'POST', headers: {
          Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json'
        },
        body: JSON.stringify(observation())
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ acceptedSequence: 1, type: 'hostd.accepted' });

      const forbidden = await fetch(`${origin}/api/compute/hostd/credentials`, {
        method: 'POST', headers: {
          Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json'
        },
        body: JSON.stringify({ deviceId, environmentId, hostId, operationId: 'device-escalation' })
      });
      expect(forbidden.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
