import { describe, expect, test } from 'bun:test';

import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import { RuntimeSessionError } from '../server/workspace-runtime-session/contracts';
import { parseRuntimeEvent } from '../server/workspace-runtime-session/validation';
import { workspaceRuntimeCapabilities } from '../src/shared/workspace-runtime-session-api';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const environmentId = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const commit = 'a'.repeat(40);
const manifestDigest = 'b'.repeat(64);
const token = 'A'.repeat(43);

function fixture() {
  let now = new Date('2026-08-12T10:00:00.000Z');
  let credential = 0;
  let session = 0;
  const store = new MemoryRuntimeSessionStore(
    { now: () => now },
    () => `33333333-3333-4333-8333-33333333333${credential++}`,
    () => credential === 1 ? token : 'B'.repeat(43)
  );
  const service = new WorkspaceRuntimeSessionService(store, () => now,
    () => `44444444-4444-4444-8444-44444444444${session++}`);
  const issue = (nextGeneration = generation, nextEnvironment = environmentId) => store.issue({
    branch: 'issue-625', capabilities: [...workspaceRuntimeCapabilities], commit,
    environmentId: nextEnvironment, generation: nextGeneration, manifestDigest,
    ownerUserId: 'owner', runtimeVersion: '0.4.66', workspaceId
  });
  const registration = (resumeAfterSequence = 0, nextGeneration = generation, nextEnvironment = environmentId) => ({
    branch: 'issue-625', commit, environmentId: nextEnvironment, generation: nextGeneration,
    manifestDigest, resumeAfterSequence, runtimeVersion: '0.4.66', schemaVersion: 1 as const,
    type: 'runtime.register' as const, workspaceId
  });
  return { issue, registration, service, setNow: (value: string) => { now = new Date(value); }, store };
}

function connection() {
  return {
    closes: [] as Array<[number, string]>, messages: [] as string[],
    close(code: number, reason: string) { this.closes.push([code, reason]); },
    send(value: string) { this.messages.push(value); }
  };
}

describe('Workspace Runtime outbound sessions', () => {
  test('registers, accepts exact replay, reconnects after a lost ack, and fences the old socket', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    expect(scope).not.toBeNull();
    const firstSocket = connection();
    const first = await runtime.service.register(firstSocket, scope!, runtime.registration());
    const running = parseRuntimeEvent({
      eventId: 'running-1', observedAt: '2026-08-12T10:00:00.000Z', schemaVersion: 1,
      sequence: 1, state: 'running', type: 'runtime.lifecycle'
    });
    const accepted = await runtime.service.append(first, running);
    expect(accepted.response).toMatchObject({ acceptedSequence: 1, replayed: false });
    expect((await runtime.service.append(first, running)).response.replayed).toBe(true);

    const secondSocket = connection();
    const second = await runtime.service.register(secondSocket, scope!, runtime.registration(0));
    expect(firstSocket.closes[0]?.[0]).toBe(1012);
    await expect(runtime.service.append(first, {
      eventId: 'old-heartbeat', observedAt: '2026-08-12T10:00:01.000Z', schemaVersion: 1,
      sequence: 2, type: 'runtime.heartbeat'
    })).rejects.toBeInstanceOf(RuntimeSessionError);
    expect(JSON.parse(secondSocket.messages[0]!)).toMatchObject({ acceptedSequence: 1, type: 'runtime.registered' });
    await runtime.service.append(second, {
      eventId: 'heartbeat-2', observedAt: '2026-08-12T10:00:01.000Z', schemaVersion: 1,
      sequence: 2, type: 'runtime.heartbeat'
    });
  });

  test('supersedes the same Workspace across environment and generation bindings', async () => {
    const runtime = fixture();
    const oldIssued = await runtime.issue();
    const oldScope = await runtime.store.authenticate(oldIssued.credential.token);
    const oldSocket = connection();
    const old = await runtime.service.register(oldSocket, oldScope!, runtime.registration());
    const nextGeneration = '55555555-5555-4555-8555-555555555555';
    const nextEnvironment = '66666666-6666-4666-8666-666666666666';
    const nextIssued = await runtime.issue(nextGeneration, nextEnvironment);
    expect(await runtime.store.authenticate(oldIssued.credential.token)).toBeNull();
    const nextScope = await runtime.store.authenticate(nextIssued.credential.token);
    await runtime.service.register(connection(), nextScope!, runtime.registration(0, nextGeneration, nextEnvironment));
    await expect(runtime.service.append(old, {
      eventId: 'late', observedAt: '2026-08-12T10:00:01.000Z', schemaVersion: 1,
      sequence: 1, type: 'runtime.heartbeat'
    })).rejects.toBeInstanceOf(RuntimeSessionError);
  });

  test('rejects changed source evidence within one generation and expires credentials fail closed', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    await expect(runtime.store.issue({
      branch: 'other-source', capabilities: [...workspaceRuntimeCapabilities], commit,
      environmentId, generation, manifestDigest, ownerUserId: 'owner',
      runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'generation_replaced' });
    expect(await runtime.store.authenticate(issued.credential.token)).not.toBeNull();
    runtime.setNow('2026-08-12T10:05:01.000Z');
    expect(await runtime.store.authenticate(issued.credential.token)).toBeNull();
  });

  test('rejects malformed credential authority before token issuance', async () => {
    const runtime = fixture();
    await expect(runtime.store.issue({
      branch: 'issue-625', capabilities: ['runtime.shell' as never], commit,
      environmentId, generation, manifestDigest, ownerUserId: 'owner',
      runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(runtime.store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeCapabilities], commit,
      environmentId, expiresInSeconds: 3_601, generation, manifestDigest,
      ownerUserId: 'owner', runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'invalid_message' });
  });

  test('uses server receive time for staleness and never infers host state', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    const socket = connection();
    await runtime.service.register(socket, scope!, runtime.registration());
    runtime.setNow('2026-08-12T10:00:46.000Z');
    const stale = await runtime.service.expireStale();
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ connectionState: 'stale', environmentId, workspaceId });
    expect(socket.closes[0]?.[1]).toContain('heartbeat expired');
  });

  test('closes a live socket when its bound credential expires', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    const socket = connection();
    runtime.setNow(issued.credential.expiresAt);
    runtime.service.closeExpired(scope!, socket);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(socket.closes).toEqual([[1008, 'Workspace Runtime credential expired.']]);
  });

  test('enforces capabilities, sequence continuity, terminal stop, and sanitized payloads', async () => {
    const runtime = fixture();
    const limited = await runtime.store.issue({
      branch: 'issue-625', capabilities: ['runtime.lifecycle'], commit, environmentId,
      generation, manifestDigest, ownerUserId: 'owner', runtimeVersion: '0.4.66', workspaceId
    });
    const scope = await runtime.store.authenticate(limited.credential.token);
    const active = await runtime.service.register(connection(), scope!, runtime.registration());
    await expect(runtime.service.append(active, {
      eventId: 'gap', observedAt: '2026-08-12T10:00:00.000Z', schemaVersion: 1,
      sequence: 2, state: 'running', type: 'runtime.lifecycle'
    })).rejects.toMatchObject({ code: 'sequence_conflict' });
    await expect(runtime.service.append(active, {
      eventId: 'heartbeat', observedAt: '2026-08-12T10:00:00.000Z', schemaVersion: 1,
      sequence: 1, type: 'runtime.heartbeat'
    })).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(() => parseRuntimeEvent({
      eventId: 'logs', observedAt: '2026-08-12T10:00:00.000Z', pointer: 'https://host/log?token=secret',
      schemaVersion: 1, sequence: 1, type: 'runtime.log-pointer'
    })).toThrow();
  });

  test('does not reopen a terminal generation after graceful stop', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    const active = await runtime.service.register(connection(), scope!, runtime.registration());
    for (const [sequence, state] of [[1, 'running'], [2, 'stopping'], [3, 'stopped']] as const) {
      await runtime.service.append(active, {
        eventId: state, observedAt: '2026-08-12T10:00:00.000Z', schemaVersion: 1,
        sequence, state, type: 'runtime.lifecycle'
      });
    }
    await expect(runtime.service.register(connection(), scope!, runtime.registration(3)))
      .rejects.toMatchObject({ code: 'generation_replaced' });
  });
});
