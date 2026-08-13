import { describe, expect, test } from 'bun:test';

import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import { RuntimeSessionError } from '../server/workspace-runtime-session/contracts';
import { parseRegistration, parseRuntimeEvent } from '../server/workspace-runtime-session/validation';
import {
  workspaceRuntimeBaseCapabilities,
  workspaceRuntimeReadyCapabilities
} from '../src/shared/workspace-runtime-session-api';
import { workspaceRuntimeCodexCapability } from '../src/shared/workspace-runtime-codex-api';

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
    branch: 'issue-625', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
    environmentId: nextEnvironment, generation: nextGeneration, manifestDigest,
    operationId: `start:${nextGeneration}:${nextEnvironment}`, ownerUserId: 'owner',
    requestedCapabilities: [...workspaceRuntimeReadyCapabilities],
    runtimeVersion: '0.4.66', workspaceId
  });
  const registration = (
    resumeAfterSequence = 0,
    nextGeneration = generation,
    nextEnvironment = environmentId,
    codex = true
  ) => ({
    branch: 'issue-625', commit, environmentId: nextEnvironment, generation: nextGeneration,
    manifestDigest, resumeAfterSequence, runtimeVersion: '0.4.66', schemaVersion: 1 as const,
    type: 'runtime.register' as const, workspaceId,
    ...(codex ? {
      readyCapabilities: [...workspaceRuntimeReadyCapabilities],
      resumeAfterCodexCommandSequence: 0,
      resumeAfterCodexEventSequence: 0
    } : {})
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
  test('keeps the first presentation when an exact launch retry loses optional context', async () => {
    const store = new MemoryRuntimeSessionStore(undefined, undefined, () => 'P'.repeat(43));
    const input = {
      branch: 'issue-717', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:presentation', ownerUserId: 'owner',
      presentation: { repository: 'DotNaos/project-space', task: { number: 717 } },
      requestedCapabilities: [...workspaceRuntimeReadyCapabilities], runtimeVersion: '0.4.66', workspaceId
    };
    const issued = await store.issue(input);
    expect(await store.authenticate(issued.credential.token)).toMatchObject({
      presentation: input.presentation
    });
    await expect(store.issue({
      ...input,
      presentation: undefined
    })).rejects.toMatchObject({ code: 'operation_in_progress' });
    expect(await store.authenticate(issued.credential.token)).toMatchObject({
      presentation: input.presentation
    });
  });

  test('keeps presentation immutable when a revoked generation is retried under a new operation', async () => {
    let credential = 0;
    const store = new MemoryRuntimeSessionStore(
      undefined,
      () => credential++ === 0 ? '33333333-3333-4333-8333-333333333330' : '33333333-3333-4333-8333-333333333331',
      () => credential === 1 ? 'Q'.repeat(43) : 'R'.repeat(43)
    );
    const input = {
      branch: 'issue-717', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:presentation-one', ownerUserId: 'owner',
      presentation: { repository: 'DotNaos/project-space', task: { number: 717 } },
      requestedCapabilities: [...workspaceRuntimeReadyCapabilities], runtimeVersion: '0.4.66', workspaceId
    };
    const issued = await store.issue(input);
    await store.revoke('owner', workspaceId, issued.credential.credentialId);
    const retried = await store.issue({
      ...input,
      operationId: 'start:presentation-two',
      presentation: { repository: 'DotNaos/project-space', task: { number: 718 } }
    });
    expect(await store.authenticate(retried.credential.token)).toMatchObject({
      presentation: input.presentation
    });
  });

  test('keeps missing presentation immutable when a revoked generation is retried', async () => {
    let credential = 0;
    const store = new MemoryRuntimeSessionStore(
      undefined,
      () => credential++ === 0 ? '33333333-3333-4333-8333-333333333330' : '33333333-3333-4333-8333-333333333331',
      () => credential === 1 ? 'S'.repeat(43) : 'T'.repeat(43)
    );
    const input = {
      branch: 'issue-717', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:generic-one', ownerUserId: 'owner',
      requestedCapabilities: [...workspaceRuntimeReadyCapabilities], runtimeVersion: '0.4.66', workspaceId
    };
    const issued = await store.issue(input);
    await store.revoke('owner', workspaceId, issued.credential.credentialId);
    const retried = await store.issue({
      ...input,
      operationId: 'start:generic-two',
      presentation: { repository: 'DotNaos/project-space', task: { number: 717 } }
    });
    expect((await store.authenticate(retried.credential.token))?.presentation).toBeUndefined();
  });

  test('uses newly verified presentation when a new generation replaces the Workspace', async () => {
    let credential = 0;
    const store = new MemoryRuntimeSessionStore(
      undefined,
      () => credential++ === 0 ? '33333333-3333-4333-8333-333333333330' : '33333333-3333-4333-8333-333333333331',
      () => credential === 1 ? 'U'.repeat(43) : 'V'.repeat(43)
    );
    const input = {
      branch: 'issue-717', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:generation-one', ownerUserId: 'owner',
      presentation: { repository: 'DotNaos/project-space', task: { number: 717 } },
      requestedCapabilities: [...workspaceRuntimeReadyCapabilities], runtimeVersion: '0.4.66', workspaceId
    };
    await store.issue(input);
    const nextPresentation = { repository: 'DotNaos/project-space', task: { number: 718 } };
    const replaced = await store.issue({
      ...input,
      generation: '55555555-5555-4555-8555-555555555555',
      operationId: 'start:generation-two',
      presentation: nextPresentation
    });
    expect(await store.authenticate(replaced.credential.token)).toMatchObject({
      presentation: nextPresentation
    });
  });

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
      branch: 'other-source', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, ownerUserId: 'owner',
      operationId: 'start:changed-source', requestedCapabilities: [...workspaceRuntimeReadyCapabilities],
      runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'generation_replaced' });
    expect(await runtime.store.authenticate(issued.credential.token)).not.toBeNull();
    runtime.setNow('2026-08-12T10:05:01.000Z');
    expect(await runtime.store.authenticate(issued.credential.token)).toBeNull();
  });

  test('does not replace an active generation credential under a new operation identity', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    await expect(runtime.store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:new-operation',
      ownerUserId: 'owner', requestedCapabilities: [...workspaceRuntimeReadyCapabilities], runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'generation_replaced' });
    expect(await runtime.store.authenticate(issued.credential.token)).not.toBeNull();
  });

  test('rejects malformed credential authority before token issuance', async () => {
    const runtime = fixture();
    await expect(runtime.store.issue({
      branch: 'issue-625', capabilities: ['runtime.shell' as never], commit,
      environmentId, generation, manifestDigest, ownerUserId: 'owner',
      operationId: 'start:invalid-capability', requestedCapabilities: [], runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(runtime.store.issue({
      branch: 'issue-625', capabilities: [workspaceRuntimeCodexCapability as never], commit,
      environmentId, generation, manifestDigest, ownerUserId: 'owner',
      operationId: 'start:effective-codex', requestedCapabilities: [], runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(runtime.store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, expiresInSeconds: 3_601, generation, manifestDigest,
      operationId: 'start:invalid-expiry', ownerUserId: 'owner', requestedCapabilities: [...workspaceRuntimeReadyCapabilities],
      runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'invalid_message' });
    await expect(runtime.store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:invalid-presentation', ownerUserId: 'owner',
      presentation: { repository: '/private/checkout' },
      requestedCapabilities: [...workspaceRuntimeReadyCapabilities], runtimeVersion: '0.4.66', workspaceId
    })).rejects.toMatchObject({ code: 'invalid_message' });
  });

  test('accepts bounded Codex reconnect watermarks without deriving authority from telemetry', () => {
    expect(parseRegistration({
      ...fixture().registration(),
      resumeAfterCodexCommandSequence: 12,
      resumeAfterCodexEventSequence: 34
    })).toMatchObject({
      resumeAfterCodexCommandSequence: 12,
      resumeAfterCodexEventSequence: 34
    });
    expect(() => parseRegistration({
      ...fixture().registration(),
      resumeAfterCodexCommandSequence: -1
    })).toThrow();
  });

  test('does not activate Codex authority from a telemetry-only registration', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    const active = await runtime.service.register(connection(), scope!,
      runtime.registration(0, generation, environmentId, false));
    expect(active.scope.capabilities).not.toContain(workspaceRuntimeCodexCapability);
    expect(() => runtime.service.dispatchCodex('owner', {
      actorId: 'actor-owner', actorKind: 'human', actorUserId: 'owner', commandId: 'command-start',
      commandSequence: 1, environmentId, generation, kind: 'runtime-start', operationId: 'operation.start',
      request: { operationId: 'operation.start' }, schemaVersion: 1, sessionId: active.sessionId,
      type: 'runtime.codex.command', workspaceId
    })).toThrowError(RuntimeSessionError);
  });

  test('rejects forged or unrequested ready promotion', async () => {
    const runtime = fixture();
    const unrequested = await runtime.store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:unrequested',
      ownerUserId: 'owner', requestedCapabilities: [],
      runtimeVersion: '0.4.66', workspaceId
    });
    const scope = await runtime.store.authenticate(unrequested.credential.token);
    await expect(runtime.service.register(connection(), scope!, runtime.registration()))
      .rejects.toMatchObject({ code: 'invalid_message' });
    expect(() => parseRegistration({
      ...runtime.registration(), readyCapabilities: ['runtime.shell']
    })).toThrow();
  });

  test('dispatches Codex commands only to the exact owner, generation, and socket binding', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    const socket = connection();
    const active = await runtime.service.register(socket, scope!, runtime.registration());
    expect(scope?.capabilities).not.toContain(workspaceRuntimeCodexCapability);
    expect(active.scope.capabilities).toContain(workspaceRuntimeCodexCapability);
    const command = {
      actorId: 'actor-owner', actorKind: 'human' as const, actorUserId: 'owner',
      commandId: 'command-start', commandSequence: 1, environmentId, generation,
      kind: 'runtime-start' as const, operationId: 'operation.start',
      request: { operationId: 'operation.start' }, schemaVersion: 1 as const,
      sessionId: active.sessionId, type: 'runtime.codex.command' as const, workspaceId
    };
    runtime.service.dispatchCodex('owner', command);
    expect(JSON.parse(socket.messages.at(-1)!)).toEqual(command);
    expect(() => runtime.service.dispatchCodex('other-owner', command))
      .toThrowError(RuntimeSessionError);
    expect(() => runtime.service.dispatchCodex('owner', {
      ...command,
      generation: '55555555-5555-4555-8555-555555555555'
    })).toThrowError(RuntimeSessionError);
    const telemetryReconnect = await runtime.service.register(
      connection(), scope!, runtime.registration(0, generation, environmentId, false)
    );
    expect(telemetryReconnect.scope.capabilities).not.toContain(workspaceRuntimeCodexCapability);
    expect(() => runtime.service.dispatchCodex('owner', {
      ...command,
      sessionId: telemetryReconnect.sessionId
    })).toThrowError(RuntimeSessionError);
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
    expect(stale[0]).toMatchObject({
      ownerUserId: 'owner',
      snapshot: { connectionState: 'stale', environmentId, workspaceId }
    });
    expect(socket.closes[0]?.[1]).toContain('heartbeat expired');
  });

  test('refreshes heartbeat freshness on reconnect before the first scheduled heartbeat', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    await runtime.service.register(connection(), scope!, runtime.registration());
    runtime.setNow('2026-08-12T10:00:40.000Z');
    await runtime.service.register(connection(), scope!, runtime.registration());
    runtime.setNow('2026-08-12T10:01:00.000Z');
    expect(await runtime.service.expireStale()).toEqual([]);
  });

  test('does not close a fresh reconnect after an older session was marked stale', async () => {
    let now = new Date('2026-08-12T10:00:00.000Z');
    class ReconnectStore extends MemoryRuntimeSessionStore {
      afterMark?: () => Promise<void>;
      override async markStale(staleBefore: string, checkedAt: string) {
        const stale = await super.markStale(staleBefore, checkedAt);
        await this.afterMark?.();
        return stale;
      }
    }
    const store = new ReconnectStore({ now: () => now },
      () => '33333333-3333-4333-8333-333333333399', () => 'E'.repeat(43));
    let nextSession = 0;
    const service = new WorkspaceRuntimeSessionService(store, () => now,
      () => `44444444-4444-4444-8444-44444444449${nextSession++}`);
    const issued = await store.issue({
      branch: 'issue-625', capabilities: [...workspaceRuntimeBaseCapabilities], commit,
      environmentId, generation, manifestDigest, operationId: 'start:stale-race',
      ownerUserId: 'owner', requestedCapabilities: [], runtimeVersion: '0.4.66', workspaceId
    });
    const scope = (await store.authenticate(issued.credential.token))!;
    const oldSocket = connection();
    await service.register(oldSocket, scope, {
      branch: 'issue-625', commit, environmentId, generation, manifestDigest,
      resumeAfterSequence: 0, runtimeVersion: '0.4.66', schemaVersion: 1,
      type: 'runtime.register', workspaceId
    });
    const newSocket = connection();
    store.afterMark = async () => {
      await service.register(newSocket, scope, {
        branch: 'issue-625', commit, environmentId, generation, manifestDigest,
        resumeAfterSequence: 0, runtimeVersion: '0.4.66', schemaVersion: 1,
        type: 'runtime.register', workspaceId
      });
    };
    now = new Date('2026-08-12T10:00:46.000Z');
    await service.expireStale();
    expect(oldSocket.closes).toEqual([[1012, 'Workspace Runtime session replaced.']]);
    expect(newSocket.closes).toEqual([]);
  });

  test('revocation closes and fences an already authenticated live socket', async () => {
    const runtime = fixture();
    const issued = await runtime.issue();
    const scope = await runtime.store.authenticate(issued.credential.token);
    const socket = connection();
    const active = await runtime.service.register(socket, scope!, runtime.registration());
    await runtime.service.revoke('owner', workspaceId, issued.credential.credentialId);
    expect(socket.closes).toEqual([[1008, 'Workspace Runtime credential revoked.']]);
    await expect(runtime.service.append(active, {
      eventId: 'after-revoke', observedAt: '2026-08-12T10:00:01.000Z', schemaVersion: 1,
      sequence: 1, type: 'runtime.heartbeat'
    })).rejects.toMatchObject({ code: 'generation_replaced' });
  });

  test('stale cleanup cannot close another owner with the same Workspace and generation IDs', async () => {
    let now = new Date('2026-08-12T10:00:00.000Z');
    let credential = 0;
    let session = 0;
    const store = new MemoryRuntimeSessionStore(
      { now: () => now },
      () => `33333333-3333-4333-8333-33333333334${credential++}`,
      () => credential === 1 ? 'C'.repeat(43) : 'D'.repeat(43)
    );
    const service = new WorkspaceRuntimeSessionService(store, () => now,
      () => `44444444-4444-4444-8444-44444444445${session++}`);
    const sockets = { first: connection(), second: connection() };
    for (const [ownerUserId, socket] of [['first-owner', sockets.first], ['second-owner', sockets.second]] as const) {
      const issued = await store.issue({
        branch: 'issue-625', capabilities: [...workspaceRuntimeBaseCapabilities], commit, environmentId,
        generation, manifestDigest, operationId: `start:${ownerUserId}`, ownerUserId,
        requestedCapabilities: [], runtimeVersion: '0.4.66', workspaceId
      });
      const scope = await store.authenticate(issued.credential.token);
      await service.register(socket, scope!, {
        branch: 'issue-625', commit, environmentId, generation, manifestDigest,
        resumeAfterSequence: 0, runtimeVersion: '0.4.66', schemaVersion: 1,
        type: 'runtime.register', workspaceId
      });
      if (ownerUserId === 'first-owner') now = new Date('2026-08-12T10:00:40.000Z');
    }
    now = new Date('2026-08-12T10:00:46.000Z');
    const stale = await service.expireStale();
    expect(stale.map((entry) => entry.ownerUserId)).toEqual(['first-owner']);
    expect(sockets.first.closes).toHaveLength(1);
    expect(sockets.second.closes).toEqual([]);
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
      generation, manifestDigest, operationId: 'start:limited', ownerUserId: 'owner',
      requestedCapabilities: [],
      runtimeVersion: '0.4.66', workspaceId
    });
    const scope = await runtime.store.authenticate(limited.credential.token);
    const active = await runtime.service.register(
      connection(), scope!, runtime.registration(0, generation, environmentId, false)
    );
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
