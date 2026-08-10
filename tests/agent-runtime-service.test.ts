import { describe, expect, test } from 'bun:test';

import {
  createAgentRuntimeService
} from '../server/agent-authorization/service';
import { MemoryAgentAuthorizationOperationStore } from '../server/agent-authorization/store';
import type { CodexAuthorizationRuntime } from '../server/codex-authorization/configured-runtime';
import type { ConfiguredComputeInventoryResult } from '../server/configured-compute-inventory';
import type { MachineRecord } from '../src/shared/project-space-api';

const environmentId = '11111111-1111-4111-8111-111111111111';
const otherEnvironmentId = '22222222-2222-4222-8222-222222222222';
const checkedAt = '2026-08-09T12:00:00.000Z';

function connector(id = 'connector-one'): MachineRecord {
  return {
    connector: {
      capabilities: [
        'codex.account.device-login.v1',
        'codex.machine-tasks.v1',
        'codex.runtime.v1'
      ],
      daemon: {
        appServerVersion: '1.2.3',
        authenticated: true,
        checkedAt,
        cliVersion: '4.5.6',
        compatible: true,
        installed: true,
        paired: true,
        reachable: true,
        remoteControlEnabled: true,
        remoteControlState: 'ready',
        running: true,
        state: 'ready'
      },
      installCommand: 'private',
      status: 'online'
    },
    id,
    kind: 'connector',
    name: id,
    network: {},
    roles: ['codex'],
    sourcePath: '/private'
  };
}

function inventory(options: {
  generation?: number;
  includeOther?: boolean;
  offline?: boolean;
} = {}): ConfiguredComputeInventoryResult {
  const first = connector();
  if (options.offline) first.connector.status = 'offline';
  const connectors = options.includeOther ? [first, connector('connector-two')] : [first];
  const environments = [environment(environmentId)];
  const associations = [association('connector-one', environmentId)];
  if (options.includeOther) {
    environments.push(environment(otherEnvironmentId));
    associations.push(association('connector-two', otherEnvironmentId));
  }
  return {
    checkedAt,
    connectors,
    generations: new Map(connectors.map((value, index) => [
      value.id,
      index === 0 ? (options.generation ?? 7) : 8
    ])),
    snapshot: {
      connectors: associations,
      environments,
      hosts: [],
      platforms: [{ id: 'codespaces', kind: 'github_codespaces', name: 'Codespaces' }],
      violations: []
    }
  };
}

function environment(id: string) {
  return {
    hostAssociation: { evidence: 'provider' as const, resolution: 'not_applicable' as const },
    id,
    identity: { key: `account:${id.replaceAll('-', '')}`, version: 1 },
    identityResolution: 'resolved' as const,
    kind: 'github_codespace' as const,
    name: `Codespace ${id.slice(0, 4)}`,
    platformId: 'codespaces',
    resourceMode: 'dedicated' as const
  };
}

function association(connectorId: string, selectedEnvironmentId: string) {
  return { associatedAt: checkedAt, connectorId, environmentId: selectedEnvironmentId };
}

function fixture(input: {
  inventory?: () => ConfiguredComputeInventoryResult;
  now?: () => Date;
  responses: Array<{
    deadlineAt?: string;
    message?: string;
    state: 'ambiguous' | 'cancelled' | 'expired' | 'failed' | 'offline' | 'pending' | 'ready' | 'unauthorized' | 'unsupported';
    userCode?: string;
    verificationUrl?: string;
  }>;
}) {
  const calls: Array<{ action: string; environmentId?: string; operationId: string }> = [];
  const authorization: CodexAuthorizationRuntime = {
    async authorize(_actor, request) {
      calls.push(request);
      return {
        action: request.action,
        apiVersion: 1,
        message: input.responses[0]?.message ?? 'Current authorization result.',
        operationId: request.operationId,
        ...(input.responses.shift() ?? { state: 'ready' })
      };
    }
  };
  const store = new MemoryAgentAuthorizationOperationStore();
  return {
    calls,
    service: createAgentRuntimeService({
      authorization,
      loadInventory: async () => (input.inventory ?? inventory)(),
      now: input.now ?? (() => new Date(checkedAt)),
      store
    }),
    store
  };
}

describe('managed agent runtime service', () => {
  test('starts once, polls the exact attempt, and replays ready through fresh status', async () => {
    const value = fixture({ responses: [{
      deadlineAt: '2026-08-09T12:15:00.000Z',
      state: 'pending',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device'
    }, { state: 'ready' }, { state: 'ready' }] });
    const request = { agent: 'codex' as const, environmentId, operationId: 'agent:login:one' };

    await expect(value.service.authorize('start', { userId: 'owner-one' }, request))
      .resolves.toMatchObject({
        polling: { tool: 'get_agent_authorization' },
        state: 'pending',
        userCode: 'ABCD-1234'
      });
    await expect(value.service.authorize('status', { userId: 'owner-one' }, request))
      .resolves.toMatchObject({ state: 'ready' });
    await expect(value.service.authorize('start', { userId: 'owner-one' }, request))
      .resolves.toMatchObject({ state: 'ready' });

    expect(value.calls.map(({ action }) => action)).toEqual(['start', 'status', 'status']);
    expect(await value.store.read('owner-one', request.operationId))
      .toMatchObject({ environmentId, state: 'ready' });
  });

  test('releases an ambiguous fence after status proves authorization is required', async () => {
    const value = fixture({ responses: [
      { state: 'ambiguous' },
      { state: 'authorization-required' },
      {
        deadlineAt: '2026-08-09T12:15:00.000Z',
        state: 'pending',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://auth.openai.com/codex/device'
      }
    ] });
    const first = { agent: 'codex' as const, environmentId, operationId: 'agent:login:uncertain' };

    await expect(value.service.authorize('start', { userId: 'owner-one' }, first))
      .resolves.toMatchObject({ state: 'ambiguous' });
    await expect(value.service.authorize('status', { userId: 'owner-one' }, first))
      .resolves.toMatchObject({ state: 'authorization-required' });
    expect(await value.store.read('owner-one', first.operationId))
      .toMatchObject({ state: 'retryable' });
    await expect(value.service.authorize('start', { userId: 'owner-one' }, {
      ...first,
      operationId: 'agent:login:replacement'
    })).resolves.toMatchObject({ state: 'pending' });
    await expect(value.service.authorize('start', { userId: 'owner-one' }, first))
      .resolves.toMatchObject({ state: 'ambiguous' });
    expect(value.calls).toHaveLength(3);
  });

  test('makes simultaneous ready polls idempotent', async () => {
    const value = fixture({ responses: [{
      deadlineAt: '2026-08-09T12:15:00.000Z',
      state: 'pending',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device'
    }, { state: 'ready' }, { state: 'ready' }] });
    const request = { agent: 'codex' as const, environmentId, operationId: 'agent:login:parallel' };
    await value.service.authorize('start', { userId: 'owner-one' }, request);

    const results = await Promise.all([
      value.service.authorize('status', { userId: 'owner-one' }, request),
      value.service.authorize('status', { userId: 'owner-one' }, request)
    ]);
    expect(results).toEqual([
      expect.objectContaining({ state: 'ready' }),
      expect.objectContaining({ state: 'ready' })
    ]);
  });

  test('fences another attempt and rejects operation reuse for another Environment', async () => {
    const value = fixture({
      inventory: () => inventory({ includeOther: true }),
      responses: [{
        deadlineAt: '2026-08-09T12:15:00.000Z',
        state: 'pending',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://auth.openai.com/codex/device'
      }]
    });
    const first = { agent: 'codex' as const, environmentId, operationId: 'agent:login:shared' };
    await value.service.authorize('start', { userId: 'owner-one' }, first);

    await expect(value.service.authorize('start', { userId: 'owner-one' }, {
      ...first,
      operationId: 'agent:login:other'
    })).resolves.toMatchObject({ state: 'ambiguous' });
    await expect(value.service.authorize('start', { userId: 'owner-one' }, {
      ...first,
      environmentId: otherEnvironmentId
    })).resolves.toMatchObject({ state: 'failed' });
    expect(value.calls).toHaveLength(1);
  });

  test('isolates the connector journal when two owners reuse the same public operation ID', async () => {
    const pending = {
      deadlineAt: '2026-08-09T12:15:00.000Z',
      state: 'pending' as const,
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device'
    };
    const value = fixture({ responses: [pending, pending] });
    const request = { agent: 'codex' as const, environmentId, operationId: 'agent:login:shared' };

    await value.service.authorize('start', { userId: 'owner-one' }, request);
    await value.service.authorize('start', { userId: 'owner-two' }, request);

    expect(value.calls).toHaveLength(2);
    expect(value.calls[0]?.operationId).not.toBe(value.calls[1]?.operationId);
    expect(value.calls.every(({ operationId }) => (
      /^agent:authorization:[0-9a-f]{64}$/.test(operationId)
    ))).toBe(true);
  });

  test('does not expose malformed device credentials or provider messages', async () => {
    const value = fixture({ responses: [{
      deadlineAt: '2026-08-09T12:15:00.000Z',
      message: 'bad\u0000message'.repeat(100),
      state: 'pending',
      userCode: 'not valid!',
      verificationUrl: 'https://attacker.example/device?token=secret'
    }] });
    const result = await value.service.authorize('start', { userId: 'owner-one' }, {
      agent: 'codex', environmentId, operationId: 'agent:login:malformed'
    });

    expect(result).toMatchObject({ state: 'ambiguous' });
    expect(result.message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(result)).not.toMatch(/attacker|secret|not valid/);
    expect(await value.store.read('owner-one', 'agent:login:malformed'))
      .toMatchObject({ state: 'ambiguous' });
  });

  test('blocks cancellation after connector generation replacement but permits status', async () => {
    let generation = 7;
    const value = fixture({
      inventory: () => inventory({ generation }),
      responses: [{
        deadlineAt: '2026-08-09T12:15:00.000Z',
        state: 'pending',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://auth.openai.com/codex/device'
      }, { state: 'ready' }]
    });
    const request = { agent: 'codex' as const, environmentId, operationId: 'agent:login:generation' };
    await value.service.authorize('start', { userId: 'owner-one' }, request);
    generation = 8;

    await expect(value.service.authorize('cancel', { userId: 'owner-one' }, request))
      .resolves.toMatchObject({ state: 'ambiguous' });
    await expect(value.service.authorize('status', { userId: 'owner-one' }, request))
      .resolves.toMatchObject({ state: 'ready' });
    expect(value.calls.map(({ action }) => action)).toEqual(['start', 'status']);
  });

  test('replays a terminal cancellation after its connector goes offline', async () => {
    let offline = false;
    const value = fixture({
      inventory: () => inventory({ offline }),
      responses: [{
        deadlineAt: '2026-08-09T12:15:00.000Z',
        state: 'pending',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://auth.openai.com/codex/device'
      }, { state: 'cancelled' }]
    });
    const request = { agent: 'codex' as const, environmentId, operationId: 'agent:login:cancelled' };
    await value.service.authorize('start', { userId: 'owner-one' }, request);
    await value.service.authorize('cancel', { userId: 'owner-one' }, request);
    offline = true;

    await expect(value.service.authorize('cancel', { userId: 'owner-one' }, request))
      .resolves.toMatchObject({ state: 'cancelled' });
    expect(value.calls.map(({ action }) => action)).toEqual(['start', 'cancel']);
  });

  test('reports fresh runtime and authorization evidence without private connector fields', async () => {
    const value = fixture({
      now: () => new Date('2026-08-09T12:03:00.000Z'),
      responses: [{ state: 'ready' }]
    });
    const result = await value.service.status({ userId: 'owner-one' }, {
      agent: 'codex', environmentId
    });

    expect(result).toMatchObject({
      environmentId,
      runtime: {
        appServerVersion: '1.2.3',
        authorization: { checkedAt: '2026-08-09T12:03:00.000Z', state: 'ready' },
        capabilities: [
          'codex.account.device-login.v1',
          'codex.machine-tasks.v1',
          'codex.runtime.v1'
        ],
        state: 'ready',
        version: '4.5.6'
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/private|installCommand|sourcePath/);
  });
});
