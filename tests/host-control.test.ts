import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { createServer } from 'node:http';

import { hostControlSchemaVersion, type HostConsoleFrame } from '../src/shared/host-control-api';
import { createHostControlHttpApi } from '../server/host-control/http';
import {
  HostControlError,
  type HostControlAuditIdentity,
  type HostControlBinding,
  type HostControlOperationStore
} from '../server/host-control/contracts';
import { MemoryHostControlOperationStore } from '../server/host-control/memory-store';
import { crc32, pngDimensions } from '../server/host-control/png';
import { createHostControlService } from '../server/host-control/service';

const hostId = '10000000-0000-4000-8000-000000000001';
const actor = { userId: 'owner-one' };
const png = validPng(2, 2);

function hostBinding(revision = 'b'.repeat(64)): HostControlBinding {
  return {
    bindingRevision: revision,
    capabilities: {
      available: true,
      console: ['screenshot', 'key', 'chord', 'text', 'mouse_move', 'mouse_click'],
      hostId,
      lastVerifiedAt: '2026-08-12T10:00:00.000Z',
      power: ['status', 'on', 'off'],
      provider: { id: 'jetkvm-os-pc', kind: 'jetkvm' },
      schemaVersion: hostControlSchemaVersion
    },
    ownerUserId: actor.userId
  };
}

function frame(frameId = 'frame-login'): HostConsoleFrame {
  return {
    capturedAt: '2026-08-12T10:00:00.000Z', frameId, height: 2, png,
    staleAfter: '2026-08-12T10:00:10.000Z', width: 2
  };
}

function setup(options: {
  approved?: boolean;
  frames?: HostConsoleFrame[];
  operations?: HostControlOperationStore;
  policyExpiresAt?: (phase: 'route_resolution' | 'execution') => string;
  now?: () => Date;
  providerFailure?: boolean;
  rateLimit?: number;
  statusHostId?: string;
  statusExtras?: Record<string, unknown>;
} = {}) {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const frames = options.frames ?? [frame()];
  let currentBinding = hostBinding();
  let frameIndex = 0;
  const service = createHostControlService({
    bindings: async () => {
      calls.push('bindings');
      return [currentBinding];
    },
    inventory: { async resolve(owner, selector) {
      calls.push('inventory');
      return owner === actor.userId && (selector === hostId || selector === 'os-pc')
        ? { id: hostId, name: 'os-pc', resolution: 'resolved' as const }
        : { resolution: 'missing' as const };
    } },
    now: options.now ?? (() => new Date('2026-08-12T10:00:01.000Z')),
    operations: options.operations ?? new MemoryHostControlOperationStore(),
    policy: {
      async admit() {
        calls.push('admit');
        return true;
      },
      async authorize(input) {
        calls.push(`authorize:${input.phase}`);
        return {
          allowed: input.risk === 'standard' || options.approved === true && input.approvalId === 'approval-one',
          decisionId: 'decision-one',
          expiresAt: options.policyExpiresAt?.(input.phase) ?? '2026-08-12T10:00:05.000Z'
        };
      }
    },
    provider: {
      async input(_binding, input) {
        calls.push('input');
        if (options.providerFailure) throw new Error('provider detail must not escape');
        inputs.push(input);
        return 'completed';
      },
      async power(_binding, state) {
        calls.push('power');
        inputs.push({ power: state });
        return 'completed';
      },
      async screenshot() {
        calls.push('screenshot');
        return frames[Math.min(frameIndex++, frames.length - 1)]!;
      },
      async status() {
        calls.push('status');
        return {
          ...currentBinding.capabilities,
          hostId: options.statusHostId ?? currentBinding.capabilities.hostId,
          powerState: 'off' as const,
          ...options.statusExtras
        };
      }
    },
    rateLimit: options.rateLimit
  });
  return {
    calls,
    inputs,
    service,
    setBindingRevision(revision: string) { currentBinding = hostBinding(revision); }
  };
}

describe('Host-scoped power and JetKVM console control', () => {
  test('keeps powered-off, BIOS, and login frames on one Host independent of SSH or Environment', async () => {
    for (const fixture of ['power-off', 'bios', 'login']) {
      const { service } = setup({ frames: [frame(`frame-${fixture}`)] });
      await expect(service.status(actor, 'os-pc')).resolves.toMatchObject({
        hostId, powerState: 'off', provider: { kind: 'jetkvm' }
      });
      await expect(service.screenshot(actor, 'os-pc')).resolves.toMatchObject({
        frameId: `frame-${fixture}`, width: 2
      });
    }
  });

  test('admits before target lookup, authorizes twice, and treats every HID action as high risk', async () => {
    const denied = setup();
    await expect(denied.service.operate(actor, hostId, {
      input: { key: 'F2', kind: 'key' }, operationId: 'boot-one', risk: 'standard'
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(denied.calls.slice(0, 3)).toEqual(['admit', 'inventory', 'bindings']);
    expect(denied.inputs).toEqual([]);

    const approved = setup({ approved: true });
    const request = {
      approvalId: 'approval-one', input: { key: 'F2', kind: 'key' as const },
      operationId: 'boot-one', risk: 'standard' as const
    };
    const first = await approved.service.operate(actor, hostId, request);
    expect(first).toMatchObject({ hostId, replayed: false, state: 'completed' });
    expect(await approved.service.operate(actor, hostId, request)).toMatchObject({ replayed: true });
    expect(approved.inputs).toHaveLength(1);
    expect(approved.calls).toContain('authorize:execution');

    for (const input of [
      { kind: 'key' as const, key: 'Escape' },
      { kind: 'text' as const, text: 'firmware input' },
      { button: 'left' as const, frameId: 'frame-login', kind: 'mouse_click' as const, x: 1, y: 1 }
    ]) {
      await expect(setup().service.operate(actor, hostId, {
        input, operationId: `denied-${input.kind}`, risk: 'standard'
      })).rejects.toMatchObject({ code: 'approval_required' });
    }
  });

  test('terminally rejects stale frames and rate limits only new dispatches', async () => {
    const moved = setup({ approved: true, rateLimit: 1 });
    const request = {
      approvalId: 'approval-one',
      input: { frameId: 'frame-login', kind: 'mouse_move' as const, x: 1, y: 1 },
      operationId: 'move-one', risk: 'standard' as const
    };
    await expect(moved.service.operate(actor, hostId, request)).resolves.toMatchObject({ state: 'completed' });
    await expect(moved.service.operate(actor, hostId, request)).resolves.toMatchObject({ replayed: true });
    await expect(moved.service.operate(actor, hostId, {
      ...request, operationId: 'move-two'
    })).rejects.toMatchObject({ code: 'rate_limited' });

    const stale = setup({ approved: true, frames: [frame('new-frame')] });
    const staleRequest = {
      approvalId: 'approval-one',
      input: { button: 'left' as const, frameId: 'old-frame', kind: 'mouse_click' as const, x: 1, y: 1 },
      operationId: 'click-one', risk: 'standard' as const
    };
    await expect(stale.service.operate(actor, hostId, staleRequest)).resolves.toMatchObject({
      code: 'stale_frame', state: 'rejected'
    });
    await expect(stale.service.operate(actor, hostId, staleRequest)).resolves.toMatchObject({
      code: 'stale_frame', replayed: true, state: 'rejected'
    });
    expect(stale.inputs).toEqual([]);
  });

  test('returns a private, structurally valid PNG frame over the typed HTTP boundary', async () => {
    const { service } = setup();
    const handler = createHostControlHttpApi(service, async () => actor);
    const server = createServer(async (request, response) => {
      if (!await handler(request, response, new URL(request.url ?? '/', 'http://127.0.0.1'))) {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/compute/hosts/os-pc/console/screenshot`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-project-frame-id')).toBe('frame-login');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('rejects truncated, corrupt, and dimension-mismatched PNG evidence', async () => {
    expect(pngDimensions(png)).toEqual({ height: 2, width: 2 });
    const corrupt = Uint8Array.from(png);
    corrupt[corrupt.length - 1] ^= 1;
    expect(pngDimensions(corrupt)).toBeUndefined();
    for (const badFrame of [
      { ...frame(), png: png.subarray(0, 8) },
      { ...frame(), png: corrupt },
      { ...frame(), width: 3 }
    ]) {
      await expect(setup({ frames: [badFrame] }).service.screenshot(actor, hostId))
        .rejects.toMatchObject({ code: 'capability_unavailable' });
    }
  });

  test('projects an allowlisted status without provider-owned runtime fields', async () => {
    const result = await setup({
      statusExtras: {
        credential: 'must-not-cross',
        deviceId: 'raw-device',
        hostname: 'private-host',
        providerMetadata: { token: 'must-not-cross' }
      }
    }).service.status(actor, hostId);
    expect(result).toEqual({
      available: true,
      console: hostBinding().capabilities.console,
      hostId,
      lastVerifiedAt: '2026-08-12T10:00:00.000Z',
      power: hostBinding().capabilities.power,
      powerState: 'off',
      provider: { id: 'jetkvm-os-pc', kind: 'jetkvm' },
      schemaVersion: 1
    });
    expect(JSON.stringify(result)).not.toContain('must-not-cross');
    expect(JSON.stringify(result)).not.toContain('raw-device');
    expect(JSON.stringify(result)).not.toContain('private-host');
  });

  test('returns a durable uncertain outcome after possible provider dispatch', async () => {
    const { service } = setup({ approved: true, providerFailure: true });
    const request = {
      approvalId: 'approval-one', input: { kind: 'text' as const, text: 'safe text' },
      operationId: 'provider-one', risk: 'standard' as const
    };
    await expect(service.operate(actor, hostId, request)).resolves.toMatchObject({
      operationId: 'provider-one', state: 'uncertain'
    });
    await expect(service.operate(actor, hostId, request)).resolves.toMatchObject({
      operationId: 'provider-one', replayed: true, state: 'uncertain'
    });
  });

  test('does not dispatch after the second policy decision expires', async () => {
    let clockReads = 0;
    const instance = setup({
      approved: true,
      now: () => new Date(++clockReads >= 5
        ? '2026-08-12T10:00:06.000Z'
        : '2026-08-12T10:00:01.000Z')
    });
    await expect(instance.service.operate(actor, hostId, {
      approvalId: 'approval-one', input: { key: 'Enter', kind: 'key' },
      operationId: 'expires-one', risk: 'standard'
    })).resolves.toMatchObject({ code: 'unauthorized', state: 'rejected' });
    expect(instance.inputs).toEqual([]);
  });

  test('durably binds the current execution decision expiry before dispatch', async () => {
    const delegate = new MemoryHostControlOperationStore();
    const dispatchExpiries: string[] = [];
    const operations: HostControlOperationStore = {
      finish: (input) => delegate.finish(input),
      markDispatchAttempted: (input) => {
        dispatchExpiries.push(input.audit.policyExpiresAt);
        return delegate.markDispatchAttempted(input);
      },
      reserve: (input) => delegate.reserve(input)
    };
    const instance = setup({
      operations,
      policyExpiresAt: (phase) => phase === 'route_resolution'
        ? '2026-08-12T10:00:05.000Z'
        : '2026-08-12T10:00:15.000Z'
    });
    await expect(instance.service.operate(actor, hostId, {
      operationId: 'power-policy-expiry', powerState: 'on', risk: 'standard'
    })).resolves.toMatchObject({ state: 'completed' });
    expect(dispatchExpiries).toEqual(['2026-08-12T10:00:15.000Z']);
  });

  test('fails closed on actor, binding, Host, and operation replay drift', async () => {
    const instance = setup();
    await expect(instance.service.status(actor, 'missing')).rejects.toBeInstanceOf(HostControlError);
    const request = { operationId: 'power-one', powerState: 'on' as const, risk: 'standard' as const };
    await instance.service.operate(actor, hostId, request);
    await expect(instance.service.operate({ callerMachineId: 'machine-two', userId: actor.userId }, hostId, request))
      .rejects.toMatchObject({ code: 'replay_conflict' });
    instance.setBindingRevision('c'.repeat(64));
    await expect(instance.service.operate(actor, hostId, request))
      .rejects.toMatchObject({ code: 'replay_conflict' });
    await expect(instance.service.operate(actor, hostId, {
      input: { kind: 'shell', command: 'whoami' }, operationId: 'unsafe-one', risk: 'standard'
    } as never)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  test('reclaims only expired pre-dispatch reservations and never redispatches uncertain work', async () => {
    const store = new MemoryHostControlOperationStore();
    const audit = auditFixture();
    const first = reservation(audit, '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:30.000Z');
    await expect(store.reserve(first)).resolves.toEqual({ kind: 'new' });
    await expect(store.reserve(reservation(audit, '2026-08-12T10:00:01.000Z', '2026-08-12T10:00:31.000Z')))
      .resolves.toEqual({ kind: 'in_progress' });
    await expect(store.reserve(reservation(audit, '2026-08-12T10:00:31.000Z', '2026-08-12T10:01:01.000Z')))
      .resolves.toEqual({ kind: 'new' });
    const reclaimed = reservation(audit, '2026-08-12T10:00:31.000Z', '2026-08-12T10:01:01.000Z');
    await expect(store.markDispatchAttempted({
      audit, attemptId: reclaimed.attemptId, dispatchedAt: '2026-08-12T10:00:32.000Z',
      dispatchedUntil: '2026-08-12T10:01:02.000Z',
      fingerprint: 'f'.repeat(64)
    })).resolves.toBe('marked');
    await expect(store.reserve(reservation(audit, '2026-08-12T10:02:00.000Z', '2026-08-12T10:02:30.000Z')))
      .resolves.toMatchObject({ kind: 'replayed', result: { state: 'uncertain' } });
  });

  test('does not let a concurrent replay or an expired attempt overwrite the dispatch winner', async () => {
    const store = new MemoryHostControlOperationStore();
    const audit = auditFixture();
    const first = reservation(audit, '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:30.000Z');
    await store.reserve(first);
    await expect(store.markDispatchAttempted({
      audit, attemptId: first.attemptId, dispatchedAt: '2026-08-12T10:00:01.000Z',
      dispatchedUntil: '2026-08-12T10:00:31.000Z',
      fingerprint: first.fingerprint
    })).resolves.toBe('marked');
    await expect(store.reserve(reservation(
      audit, '2026-08-12T10:00:02.000Z', '2026-08-12T10:00:32.000Z'
    ))).resolves.toEqual({ kind: 'in_progress' });

    const secondStore = new MemoryHostControlOperationStore();
    const expired = reservation(audit, '2026-08-12T10:00:00.000Z', '2026-08-12T10:00:30.000Z');
    const winner = reservation(audit, '2026-08-12T10:00:31.000Z', '2026-08-12T10:01:01.000Z');
    await secondStore.reserve(expired);
    await secondStore.reserve(winner);
    await expect(secondStore.markDispatchAttempted({
      audit, attemptId: expired.attemptId, dispatchedAt: '2026-08-12T10:00:32.000Z',
      dispatchedUntil: '2026-08-12T10:01:02.000Z',
      fingerprint: expired.fingerprint
    })).resolves.toBe('fenced');
    await expect(secondStore.markDispatchAttempted({
      audit, attemptId: winner.attemptId, dispatchedAt: '2026-08-12T10:00:32.000Z',
      dispatchedUntil: '2026-08-12T10:01:02.000Z',
      fingerprint: winner.fingerprint
    })).resolves.toBe('marked');
  });
});

function auditFixture(): HostControlAuditIdentity {
  return {
    actorId: 'owner-one', actorKind: 'human', auditId: '20000000-0000-4000-8000-000000000002',
    bindingRevision: 'b'.repeat(64), capability: 'host.power.on', effectiveRisk: 'standard', hostId,
    operationId: 'lease-one', ownerUserId: actor.userId, policyDecisionId: 'decision-one',
    policyExpiresAt: '2026-08-12T10:05:00.000Z', providerId: 'jetkvm-os-pc'
  };
}

function reservation(audit: HostControlAuditIdentity, reservedAt: string, reservedUntil: string) {
  return {
    audit,
    attemptId: reservedAt.endsWith('00.000Z')
      ? '30000000-0000-4000-8000-000000000003'
      : reservedAt.endsWith('01.000Z')
        ? '40000000-0000-4000-8000-000000000004'
        : '50000000-0000-4000-8000-000000000005',
    fingerprint: 'f'.repeat(64), rateLimit: 30, reservedAt, reservedUntil
  };
}

function validPng(width: number, height: number) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  return Uint8Array.from(Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

function chunk(type: string, payload: Buffer) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length, 0);
  name.copy(result, 4);
  payload.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, payload])), payload.length + 8);
  return result;
}
