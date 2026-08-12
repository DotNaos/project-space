import { describe, expect, test } from 'bun:test';

import { MemoryCanonicalRuntimeControlOperationStore } from '../server/canonical-runtime-control/memory-operation-store';
import { CanonicalRuntimeControlError } from '../server/canonical-runtime-control/contracts';
import { createCanonicalRuntimeControlService } from '../server/canonical-runtime-control/service';
import { createWorkspaceRuntimeControlDispatcher } from '../server/canonical-runtime-control/workspace-runtime-dispatcher';
import { MemoryRuntimeSessionStore } from '../server/workspace-runtime-session/memory-store';
import { WorkspaceRuntimeSessionService } from '../server/workspace-runtime-session/service';
import {
  canonicalRuntimeControlApiVersion,
  canonicalRuntimeControlOperations,
  type CanonicalRuntimeControlOperation,
  type CanonicalRuntimeControlOutput
} from '../src/shared/canonical-runtime-control-api';
import type { ComputeInventorySnapshot } from '../src/shared/compute-environment-api';
import type { WorkspaceRuntimeSessionSnapshot } from '../src/shared/workspace-runtime-session-api';
import {
  workspaceRuntimeBaseCapabilities,
  workspaceRuntimeControlCapability,
  workspaceRuntimeMutationCapability
} from '../src/shared/workspace-runtime-session-api';
import { parseRuntimeControlMessage } from '../server/workspace-runtime-session/validation';

const environmentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const generation = '22222222-2222-4222-8222-222222222222';
const actor = { actorId: 'flora', actorKind: 'agent' as const, ownerUserId: 'owner' };

function fixture(options: {
  authorized?: boolean;
  deniedPhase?: 'coarse' | 'exact';
  runtime?: Partial<WorkspaceRuntimeSessionSnapshot>;
  runtimeAfterAuthorization?: Partial<WorkspaceRuntimeSessionSnapshot>;
} = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const results = new Map<string, { fingerprint: string; result: unknown }>();
  let runtimeReads = 0;
  const compute = {
    connectors: [{ associatedAt: new Date(0).toISOString(), connectorId: 'legacy-connector', environmentId }],
    environmentDefinitions: [{
      bootstrapStrategy: 'workspace_runtime', id: 'definition', kind: 'docker', name: 'Runtime',
      operatingSystemFamily: 'other', ownership: 'built_in', slug: 'runtime', supportedArchitectures: []
    }],
    environments: [{
      environmentDefinitionId: 'definition', hostAssociation: { evidence: 'none', resolution: 'not_applicable' },
      id: environmentId, identity: { key: 'environment:canonical', version: 7 }, kind: 'docker',
      name: 'Canonical runtime', platformId: 'platform', resourceMode: 'dedicated'
    }],
    hosts: [],
    platforms: [{ id: 'platform', kind: 'local', name: 'Local' }],
    violations: []
  } satisfies ComputeInventorySnapshot;
  const runtime = {
    branch: 'issue-647', capabilities: [
      workspaceRuntimeControlCapability,
      workspaceRuntimeMutationCapability
    ], commit: 'a'.repeat(40),
    connectionState: 'online', devServers: [], environmentId, expiresAt: '2026-08-13T00:00:00.000Z',
    generation, lastEventAt: '2026-08-12T00:00:00.000Z', lastHeartbeatAt: '2026-08-12T00:00:00.000Z',
    lastSequence: 1, lifecycleState: 'running', manifestDigest: 'b'.repeat(64), runtimeVersion: '1.0.0',
    schemaVersion: 1, sessionId: 'session-runtime', workspaceId, ...options.runtime
  } satisfies WorkspaceRuntimeSessionSnapshot;
  const service = createCanonicalRuntimeControlService({
    authorizer: {
      async authorize(input) {
        calls.push({
          phase: input.phase,
          operation: input.operation,
          safeInput: input.safeInput,
          ...(input.phase === 'exact' ? { target: input.target } : {})
        });
        return options.authorized !== false && input.phase !== options.deniedPhase;
      }
    },
    dispatcher: {
      async replay(input) {
        const prior = results.get(input.request.operationId);
        if (!prior) return undefined;
        if (prior.fingerprint !== input.fingerprint) return 'conflict' as const;
        return { ...(prior.result as object), replayed: true } as never;
      },
      async dispatch(input) {
        calls.push({
          dispatched: input.request.operation,
          environmentId: input.target.environmentId,
          generation: input.target.generation,
          workspaceId: input.target.workspaceId
        });
        const result = {
          apiVersion: 1 as const,
          compatibilityAlias: false,
          environmentId: input.target.environmentId,
          generation: input.target.generation,
          operation: input.request.operation,
          operationId: input.request.operationId,
          output: output(input.request.operation),
          replayed: false,
          state: 'completed' as const,
          targetIdentityRevision: input.target.targetIdentityRevision,
          workspaceId: input.target.workspaceId
        };
        results.set(input.request.operationId, { fingerprint: input.fingerprint, result });
        return result as never;
      }
    },
    inventory: {
      async compute() { calls.push({ inventory: 'compute' }); return compute; },
      async runtimes() {
        calls.push({ inventory: 'runtimes' });
        runtimeReads += 1;
        return [{
          ...runtime,
          ...(runtimeReads > 1 ? options.runtimeAfterAuthorization : {})
        }];
      }
    }
  });
  return { calls, compute, runtime, service };
}

function request(operation: CanonicalRuntimeControlOperation, operationId = `operation:${operation}`) {
  const input = (() => {
    switch (operation) {
      case 'git.diff': return { staged: false };
      case 'git.stage':
      case 'git.unstage': return { expectedHead: 'a'.repeat(40), scope: 'all' as const };
      case 'git.commit': return { expectedHead: 'a'.repeat(40), message: 'Canonical commit' };
      case 'task.start': return {
        taskExecutionId: '33333333-3333-4333-8333-333333333333',
        workspaceLeaseId: '44444444-4444-4444-8444-444444444444'
      };
      case 'dev-server.start': return { serverId: 'dev' };
      case 'dev-server.publish':
      case 'dev-server.stop': return { expectedServerGeneration: 'server-generation:3', serverId: 'dev' };
      default: return {};
    }
  })();
  return {
    apiVersion: canonicalRuntimeControlApiVersion,
    environmentId,
    expectedGeneration: generation,
    expectedTargetIdentityRevision: '7:environment:canonical',
    operation,
    operationId,
    ...input,
    workspaceId
  } as Parameters<ReturnType<typeof createCanonicalRuntimeControlService>['execute']>[1];
}

function output(operation: CanonicalRuntimeControlOperation): CanonicalRuntimeControlOutput {
  switch (operation) {
    case 'git.status': return {
      clean: true, conflicted: 0, staged: 0, truncated: false, unstaged: 0, untracked: 0
    };
    case 'git.diff': return {
      addedLines: 2, binaryFiles: 0, changedFiles: 1, deletedLines: 1, staged: false, truncated: false
    };
    case 'worktree.list': return {
      current: 1, detached: 0, locked: 0, prunable: 0, total: 1, truncated: false
    };
    case 'git.stage':
    case 'git.unstage': return {
      changed: true, clean: false, conflicted: 0, head: 'a'.repeat(40), staged: 1,
      truncated: false, unstaged: 0, untracked: 0
    };
    case 'git.commit': return { commit: 'b'.repeat(40), parent: 'a'.repeat(40) };
    case 'task.start': return {
      state: 'ready_for_agent', taskExecutionId: '33333333-3333-4333-8333-333333333333'
    };
    case 'dev-server.inspect': return { failed: 0, ready: 1, starting: 0, stopped: 0, total: 1 };
    case 'dev-server.start': return { serverGeneration: 'server-generation:1', serverId: 'dev', state: 'ready' };
    case 'dev-server.publish': return { serverGeneration: 'server-generation:3', serverId: 'dev', state: 'published' };
    case 'dev-server.stop': return { serverGeneration: 'server-generation:3', serverId: 'dev', state: 'stopped' };
  }
}

describe('canonical runtime control', () => {
  test('routes every migrated responsibility through one exact Runtime target without Connector input', async () => {
    const runtime = fixture();
    for (const operation of canonicalRuntimeControlOperations) {
      expect(await runtime.service.execute(actor, request(operation))).toMatchObject({
        compatibilityAlias: false,
        environmentId,
        generation,
        operation,
        state: 'completed',
        workspaceId
      });
    }
    const dispatches = runtime.calls.filter((entry) => entry.dispatched);
    expect(dispatches).toHaveLength(canonicalRuntimeControlOperations.length);
    expect(dispatches.every((entry) => !('connectorId' in entry))).toBe(true);
  });

  test('fails closed for ambiguous identities, stale generations, and denied actors', async () => {
    await expect(fixture({ runtime: { generation: 'different-generation' } }).service.execute(
      actor,
      request('git.status', 'canonical:stale')
    )).rejects.toMatchObject({ code: 'target_unavailable' });
    const denied = fixture({ authorized: false });
    await expect(denied.service.execute(
      actor,
      request('git.status', 'canonical:denied')
    )).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(denied.calls.some(({ inventory }) => inventory)).toBe(false);
    const exactDenied = fixture({ deniedPhase: 'exact' });
    await expect(exactDenied.service.execute(
      actor,
      request('git.status', 'canonical:exact-denied')
    )).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(exactDenied.calls.filter(({ inventory }) => inventory === 'runtimes')).toHaveLength(1);
    expect(exactDenied.calls.some(({ dispatched }) => dispatched)).toBe(false);
  });

  test('freshly resolves the complete authorized target and never dispatches after drift', async () => {
    const runtime = fixture({ runtimeAfterAuthorization: { sessionId: 'replacement-session' } });
    await expect(runtime.service.execute(actor, request('git.status', 'canonical:drift')))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    expect(runtime.calls.filter(({ inventory }) => inventory === 'runtimes')).toHaveLength(2);
    expect(runtime.calls.some(({ dispatched }) => dispatched)).toBe(false);
  });

  test('replays identical input and rejects operation ID reuse with changed input', async () => {
    const runtime = fixture();
    const first = await runtime.service.execute(actor, request('git.status', 'stable-operation'));
    const inventoryReadsAfterDispatch = runtime.calls.filter(({ inventory }) => inventory).length;
    const replay = await runtime.service.execute(actor, request('git.status', 'stable-operation'));
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(runtime.calls.filter(({ inventory }) => inventory)).toHaveLength(inventoryReadsAfterDispatch);
    await expect(runtime.service.execute(actor, request('git.diff', 'stable-operation')))
      .rejects.toMatchObject({ code: 'operation_conflict' });
    expect(runtime.calls.filter(({ inventory }) => inventory)).toHaveLength(inventoryReadsAfterDispatch);
    expect(runtime.calls.filter(({ dispatched }) => dispatched)).toHaveLength(1);
  });

  test('rejects unknown request fields before target resolution', async () => {
    await expect(fixture().service.execute(actor, {
      ...request('git.status', 'unsafe-payload'),
      secretToken: 'do-not-store'
    } as never)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('rejects every caller-controlled mutation escape hatch and malformed bounded input', async () => {
    const runtime = fixture();
    for (const unsafe of [
      { ...request('git.stage', 'unsafe:path'), paths: ['secret.txt'] },
      { ...request('git.unstage', 'unsafe:cwd'), cwd: '/tmp/repository' },
      { ...request('git.commit', 'unsafe:message'), message: 'line one\nline two' },
      { ...request('task.start', 'unsafe:command'), command: 'rm -rf project' },
      { ...request('dev-server.start', 'unsafe:connector'), connectorId: 'legacy' },
      { ...request('dev-server.publish', 'unsafe:url'), url: 'https://public.example' },
      { ...request('dev-server.stop', 'unsafe:generation'), expectedServerGeneration: '' }
    ]) {
      await expect(runtime.service.execute(actor, unsafe as never))
        .rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(runtime.calls.some(({ inventory }) => inventory)).toBe(false);
  });

  test('requires mutation Runtime authority independently from inspection authority', async () => {
    const runtime = fixture({ runtime: { capabilities: [workspaceRuntimeControlCapability] } });
    await expect(runtime.service.execute(actor, request('git.stage', 'mutation:capability')))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    await expect(runtime.service.execute(actor, request('git.status', 'read:capability')))
      .resolves.toMatchObject({ state: 'completed' });
  });

  test('authorizes bounded mutation input before lookup and the complete target before dispatch', async () => {
    const runtime = fixture();
    await runtime.service.execute(actor, request('git.commit', 'mutation:auth-order'));
    expect(runtime.calls[0]).toMatchObject({
      operation: 'git.commit',
      phase: 'coarse',
      safeInput: {
        expectedHead: 'a'.repeat(40),
        message: 'Canonical commit',
        operation: 'git.commit'
      }
    });
    const exact = runtime.calls.filter(({ phase }) => phase === 'exact');
    expect(exact).toHaveLength(2);
    expect(exact.every((entry) => JSON.stringify(entry.target) === JSON.stringify({
      branch: 'issue-647',
      commit: 'a'.repeat(40),
      environmentId,
      generation,
      manifestDigest: 'b'.repeat(64),
      platformId: 'platform',
      sessionId: 'session-runtime',
      targetIdentityRevision: '7:environment:canonical',
      workspaceId
    }))).toBe(true);
    const firstInventory = runtime.calls.findIndex(({ inventory }) => Boolean(inventory));
    const coarse = runtime.calls.findIndex(({ phase }) => phase === 'coarse');
    expect(coarse).toBeLessThan(firstInventory);
  });

  test('dispatches through the authenticated outbound Runtime socket with no Connector process', async () => {
    const base = fixture();
    const store = new MemoryRuntimeSessionStore();
    const operations = new MemoryCanonicalRuntimeControlOperationStore();
    const sessions = new WorkspaceRuntimeSessionService(
      store,
      undefined,
      undefined,
      { read: (...args) => operations.watermarks(...args) }
    );
    const issued = await store.issue({
      branch: 'issue-647', capabilities: [...workspaceRuntimeBaseCapabilities],
      commit: 'a'.repeat(40), environmentId, generation, manifestDigest: 'b'.repeat(64),
      operationId: 'runtime-control-credential', ownerUserId: actor.ownerUserId,
      requestedCapabilities: [
        workspaceRuntimeControlCapability,
        workspaceRuntimeMutationCapability
      ], runtimeVersion: '1.0.0',
      workspaceId
    });
    const scope = await store.authenticate(issued.credential.token);
    expect(scope).not.toBeNull();
    const socket = {
      close() {},
      messages: [] as string[],
      send(value: string) { this.messages.push(value); }
    };
    const active = await sessions.register(socket, scope!, {
      branch: 'issue-647', commit: 'a'.repeat(40), environmentId, generation,
      manifestDigest: 'b'.repeat(64), readyCapabilities: [
        workspaceRuntimeControlCapability,
        workspaceRuntimeMutationCapability
      ],
      resumeAfterControlCommandSequence: 0, resumeAfterControlEventSequence: 0,
      resumeAfterSequence: 0, runtimeVersion: '1.0.0', schemaVersion: 1,
      type: 'runtime.register', workspaceId
    });
    await sessions.append(active, {
      eventId: 'runtime-running', observedAt: new Date().toISOString(), schemaVersion: 1,
      sequence: 1, state: 'running', type: 'runtime.lifecycle'
    });
    const dispatcher = createWorkspaceRuntimeControlDispatcher(
      sessions,
      operations,
      { timeoutMs: 1_000 }
    );
    const service = createCanonicalRuntimeControlService({
      authorizer: { async authorize() { return true; } },
      dispatcher,
      inventory: {
        async compute() { return base.compute; },
        async runtimes() { return sessions.list(actor.ownerUserId); }
      }
    });
    const mismatched = service.execute(actor, request('dev-server.inspect', 'runtime:mismatched-binding'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstCommand = JSON.parse(socket.messages.at(-1)!) as Record<string, unknown>;
    await expect(sessions.acceptControl(active, {
      ...firstCommand,
      eventSequence: 1,
      output: { failed: 0, ready: 1, starting: 0, stopped: 0, total: 1 },
      state: 'completed',
      targetIdentityRevision: '8:changed-environment',
      type: 'runtime.control.result'
    } as never)).rejects.toThrow('binding changed');
    await expect(mismatched).resolves.toMatchObject({ state: 'uncertain' });

    const pending = service.execute(actor, request('dev-server.inspect', 'runtime:dev-server-inspect'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = JSON.parse(socket.messages.at(-1)!) as Record<string, unknown>;
    expect(command).toMatchObject({
      environmentId,
      generation,
      operation: 'dev-server.inspect',
      targetIdentityRevision: '7:environment:canonical',
      type: 'runtime.control.command',
      workspaceId
    });
    await sessions.acceptControl(active, {
      ...command,
      acceptedCommandSequence: command.commandSequence,
      eventSequence: 1,
      replayed: false,
      type: 'runtime.control.command-accepted'
    } as never);
    await sessions.acceptControl(active, {
      ...command,
      eventSequence: 2,
      output: { failed: 0, ready: 1, starting: 0, stopped: 0, total: 1 },
      state: 'completed',
      type: 'runtime.control.result'
    } as never);
    await expect(pending).resolves.toMatchObject({
      output: { failed: 0, ready: 1, starting: 0, stopped: 0, total: 1 },
      state: 'completed'
    });

    const mutation = service.execute(actor, request('dev-server.stop', 'runtime:dev-server-stop'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const mutationCommand = JSON.parse(socket.messages.at(-1)!) as Record<string, unknown>;
    expect(mutationCommand).toMatchObject({
      environmentId,
      expectedServerGeneration: 'server-generation:3',
      generation,
      operation: 'dev-server.stop',
      serverId: 'dev',
      type: 'runtime.control.command',
      workspaceId
    });
    expect(mutationCommand).not.toHaveProperty('path');
    expect(mutationCommand).not.toHaveProperty('command');
    expect(mutationCommand).not.toHaveProperty('connectorId');
    await sessions.acceptControl(active, {
      ...mutationCommand,
      acceptedCommandSequence: mutationCommand.commandSequence,
      eventSequence: 3,
      replayed: false,
      type: 'runtime.control.command-accepted'
    } as never);
    await expect(sessions.acceptControl(active, {
      ...mutationCommand,
      eventSequence: 4,
      output: { serverGeneration: 'server-generation:other', serverId: 'dev', state: 'stopped' },
      state: 'completed',
      type: 'runtime.control.result'
    } as never)).rejects.toThrow('binding changed');
    await sessions.acceptControl(active, {
      ...mutationCommand,
      eventSequence: 4,
      output: { serverGeneration: 'server-generation:3', serverId: 'dev', state: 'stopped' },
      state: 'completed',
      type: 'runtime.control.result'
    } as never);
    await expect(mutation).resolves.toMatchObject({
      output: { serverGeneration: 'server-generation:3', serverId: 'dev', state: 'stopped' },
      state: 'completed'
    });
    expect((await operations.read(actor.ownerUserId, 'runtime:dev-server-stop'))?.identity)
      .toMatchObject({
        accessMode: 'mutation',
        safeInput: {
          expectedServerGeneration: 'server-generation:3',
          operation: 'dev-server.stop',
          serverId: 'dev'
        }
      });
    dispatcher.close();
    sessions.close();
  });

  test('resends an unresolved command after reconnect even when the Runtime already accepted its sequence', async () => {
    const sessionStore = new MemoryRuntimeSessionStore();
    const operations = new MemoryCanonicalRuntimeControlOperationStore();
    const sessions = new WorkspaceRuntimeSessionService(
      sessionStore,
      undefined,
      undefined,
      { read: (...args) => operations.watermarks(...args) }
    );
    const identity = {
      actorId: actor.actorId, actorKind: actor.actorKind, actorUserId: actor.ownerUserId,
      accessMode: 'read' as const, compatibilityAlias: false, environmentId, generation,
      operation: 'git.status' as const,
      operationId: 'runtime:crash-after-accept', ownerUserId: actor.ownerUserId,
      safeInput: { operation: 'git.status' as const },
      sessionId: 'session-before-crash', targetIdentityRevision: '7:environment:canonical', workspaceId
    };
    const reservedAt = new Date().toISOString();
    await operations.reserve({
      fingerprint: 'c'.repeat(64), identity, reservedAt,
      reservedUntil: new Date(Date.now() + 10_000).toISOString()
    });
    await operations.markDispatchAttempted({
      commandId: identity.operationId, dispatchedAt: reservedAt,
      dispatchedUntil: new Date(Date.now() + 30_000).toISOString(),
      fingerprint: 'c'.repeat(64), identity
    });
    const dispatcher = createWorkspaceRuntimeControlDispatcher(sessions, operations);
    const issued = await sessionStore.issue({
      branch: 'issue-657', capabilities: [...workspaceRuntimeBaseCapabilities], commit: 'a'.repeat(40),
      environmentId, generation, manifestDigest: 'b'.repeat(64), operationId: 'runtime-reconnect',
      ownerUserId: actor.ownerUserId, requestedCapabilities: [workspaceRuntimeControlCapability],
      runtimeVersion: '1.0.0', workspaceId
    });
    const scope = await sessionStore.authenticate(issued.credential.token);
    const socket = {
      close() {}, messages: [] as string[], send(value: string) { this.messages.push(value); }
    };
    await sessions.register(socket, scope!, {
      branch: 'issue-657', commit: 'a'.repeat(40), environmentId, generation,
      manifestDigest: 'b'.repeat(64), readyCapabilities: [workspaceRuntimeControlCapability],
      resumeAfterControlCommandSequence: 1, resumeAfterControlEventSequence: 0,
      resumeAfterSequence: 0, runtimeVersion: '1.0.0', schemaVersion: 1,
      type: 'runtime.register', workspaceId
    });
    expect(socket.messages.map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      commandSequence: 1, operationId: identity.operationId, sessionId: expect.any(String),
      type: 'runtime.control.command'
    }));
    dispatcher.close();
    sessions.close();
  });

  test('terminally fences a known pre-send target change from reconnect recovery', async () => {
    const operations = new MemoryCanonicalRuntimeControlOperationStore();
    let registrationListener: ((input: {
      generation: string; ownerUserId: string; resumeAfterCommandSequence: number;
      sessionId: string; workspaceId: string;
    }) => Promise<void> | void) | undefined;
    let dispatches = 0;
    const sessions = {
      dispatchControl() { dispatches += 1; },
      onControlMessage() { return () => {}; },
      onControlRegistration(listener: typeof registrationListener) {
        registrationListener = listener;
        return () => {};
      }
    } as unknown as WorkspaceRuntimeSessionService;
    const dispatcher = createWorkspaceRuntimeControlDispatcher(sessions, operations);
    const controlRequest = request('git.status', 'runtime:known-target-change');
    await expect(dispatcher.dispatch({
      actor,
      fingerprint: 'd'.repeat(64),
      freshTarget: async () => {
        throw new CanonicalRuntimeControlError('target_unavailable', 'Target changed.');
      },
      request: controlRequest,
      target: {
        branch: 'issue-657', commit: 'a'.repeat(40), environmentId, generation,
        manifestDigest: 'b'.repeat(64), platformId: 'platform', sessionId: 'session-before-change',
        targetIdentityRevision: controlRequest.expectedTargetIdentityRevision, workspaceId
      }
    })).resolves.toMatchObject({ state: 'failed' });
    expect((await operations.read(actor.ownerUserId, controlRequest.operationId))?.state).toBe('failed');
    expect(await operations.unresolved(actor.ownerUserId, workspaceId, generation)).toEqual([]);
    await registrationListener?.({
      generation, ownerUserId: actor.ownerUserId, resumeAfterCommandSequence: 0,
      sessionId: 'session-after-change', workspaceId
    });
    expect(dispatches).toBe(0);
    dispatcher.close();
  });

  test('rejects result schema leaks and mismatched full socket bindings', async () => {
    const store = new MemoryRuntimeSessionStore();
    const issued = await store.issue({
      branch: 'issue-657', capabilities: [...workspaceRuntimeBaseCapabilities], commit: 'a'.repeat(40),
      environmentId, generation, manifestDigest: 'b'.repeat(64), operationId: 'control-parser',
      ownerUserId: actor.ownerUserId, requestedCapabilities: [workspaceRuntimeControlCapability],
      runtimeVersion: '1.0.0', workspaceId
    });
    const scope = await store.authenticate(issued.credential.token);
    expect(scope).not.toBeNull();
    const binding = {
      actorId: actor.actorId, actorKind: actor.actorKind, actorUserId: actor.ownerUserId,
      commandId: 'command-1', commandSequence: 1, environmentId, eventSequence: 1, generation,
      operation: 'git.diff' as const, operationId: 'operation-1', schemaVersion: 1 as const,
      sessionId: 'session-runtime', targetIdentityRevision: '7:environment:canonical', workspaceId
    };
    const activeScope = {
      ...scope!, capabilities: [
        ...scope!.capabilities,
        workspaceRuntimeControlCapability,
        workspaceRuntimeMutationCapability
      ]
    };
    for (const operation of canonicalRuntimeControlOperations) {
      expect(parseRuntimeControlMessage({
        ...binding, operation, output: output(operation), state: 'completed',
        type: 'runtime.control.result'
      }, activeScope, binding.sessionId)).toMatchObject({ operation, state: 'completed' });
    }
    expect(() => parseRuntimeControlMessage({
      ...binding, output: {
        addedLines: 1, binaryFiles: 0, changedFiles: 1, deletedLines: 0,
        patch: 'secret', staged: false, truncated: false
      },
      state: 'completed', type: 'runtime.control.result'
    }, activeScope, binding.sessionId))
      .toThrow();
    expect(() => parseRuntimeControlMessage({
      ...binding,
      code: 'blocked_dependency',
      message: 'Dependency unavailable.',
      operation: 'git.stage',
      type: 'runtime.control.error'
    }, activeScope, binding.sessionId)).toThrow();
    expect(parseRuntimeControlMessage({
      ...binding,
      code: 'blocked_dependency',
      message: 'Codex host controller unavailable.',
      operation: 'task.start',
      type: 'runtime.control.error'
    }, activeScope, binding.sessionId)).toMatchObject({
      code: 'blocked_dependency', operation: 'task.start'
    });
  });
});
