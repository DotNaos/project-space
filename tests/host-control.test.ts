import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';

import { hostControlSchemaVersion, type HostConsoleFrame } from '../src/shared/host-control-api';
import { createHostControlHttpApi } from '../server/host-control/http';
import { HostControlError, type HostControlBinding } from '../server/host-control/contracts';
import { createHostControlService, MemoryHostControlOperationStore } from '../server/host-control/service';

const hostId = '10000000-0000-4000-8000-000000000001';
const actor = { userId: 'owner-one' };
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const binding: HostControlBinding = {
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

function frame(frameId = 'frame-login'): HostConsoleFrame {
  return {
    capturedAt: '2026-08-12T10:00:00.000Z', frameId, height: 1080, png,
    staleAfter: '2026-08-12T10:00:10.000Z', width: 1920
  };
}

function setup(options: {
  approved?: boolean;
  frames?: HostConsoleFrame[];
  providerFailure?: boolean;
  rateLimit?: number;
  statusHostId?: string;
} = {}) {
  const inputs: unknown[] = [];
  const frames = options.frames ?? [frame()];
  let frameIndex = 0;
  const service = createHostControlService({
    bindings: async () => [binding],
    inventory: { async resolve(owner, selector) {
      return owner === actor.userId && (selector === hostId || selector === 'os-pc')
        ? { id: hostId, name: 'os-pc', resolution: 'resolved' as const }
        : { resolution: 'missing' as const };
    } },
    now: () => new Date('2026-08-12T10:00:01.000Z'),
    operations: new MemoryHostControlOperationStore(),
    policy: { async authorize(input) {
      return input.risk === 'standard' || options.approved === true && input.approvalId === 'approval-one';
    } },
    provider: {
      async input(_binding, input) {
        if (options.providerFailure) throw new Error('provider detail must not escape');
        inputs.push(input);
      },
      async power(_binding, state) { inputs.push({ power: state }); },
      async screenshot() { return frames[Math.min(frameIndex++, frames.length - 1)]!; },
      async status() {
        return {
          ...binding.capabilities, hostId: options.statusHostId ?? binding.capabilities.hostId,
          powerState: 'off' as const
        };
      }
    },
    rateLimit: options.rateLimit
  });
  return { inputs, service };
}

describe('Host-scoped power and JetKVM console control', () => {
  test('keeps powered-off, BIOS, and login frames on one Host independent of SSH or Environment', async () => {
    for (const fixture of ['power-off', 'bios', 'login']) {
      const { service } = setup({ frames: [frame(`frame-${fixture}`)] });
      await expect(service.status(actor, 'os-pc')).resolves.toMatchObject({
        hostId, powerState: 'off', provider: { kind: 'jetkvm' }
      });
      await expect(service.screenshot(actor, 'os-pc')).resolves.toMatchObject({
        frameId: `frame-${fixture}`, width: 1920
      });
    }
  });

  test('blocks boot input without approval and audits an approved exact replay', async () => {
    const denied = setup();
    await expect(denied.service.operate(actor, hostId, {
      input: { key: 'F2', kind: 'key' }, operationId: 'boot-one', risk: 'standard'
    })).rejects.toMatchObject({ code: 'approval_required' });
    expect(denied.inputs).toEqual([]);

    const approved = setup({ approved: true });
    const request = {
      approvalId: 'approval-one', input: { key: 'F2', kind: 'key' as const },
      operationId: 'boot-one', risk: 'boot' as const
    };
    const first = await approved.service.operate(actor, hostId, request);
    expect(first).toMatchObject({ hostId, replayed: false, state: 'completed' });
    expect(await approved.service.operate(actor, hostId, request)).toMatchObject({ replayed: true });
    expect(approved.inputs).toHaveLength(1);

    await expect(setup().service.operate(actor, hostId, {
      input: { kind: 'chord', keys: ['Alt', 'F10'] }, operationId: 'boot-two', risk: 'standard'
    })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(setup().service.operate(actor, hostId, {
      operationId: 'power-off-one', powerState: 'off', risk: 'standard'
    })).rejects.toMatchObject({ code: 'approval_required' });
  });

  test('bounds coordinates, rejects stale frames, rate limits input, and exposes provider failures', async () => {
    const moved = setup({ rateLimit: 1 });
    await moved.service.operate(actor, hostId, {
      input: { frameId: 'frame-login', kind: 'mouse_move', x: 1919, y: 1079 },
      operationId: 'move-one', risk: 'standard'
    });
    await expect(moved.service.operate(actor, hostId, {
      input: { frameId: 'frame-login', kind: 'mouse_move', x: 1, y: 1 },
      operationId: 'move-two', risk: 'standard'
    })).rejects.toMatchObject({ code: 'rate_limited' });

    const stale = setup({ frames: [frame('new-frame')] });
    await expect(stale.service.operate(actor, hostId, {
      input: { button: 'left', frameId: 'old-frame', kind: 'mouse_click', x: 1, y: 1 },
      operationId: 'click-one', risk: 'standard'
    })).rejects.toMatchObject({ code: 'stale_frame' });
    expect(stale.inputs).toEqual([]);
  });

  test('returns a private PNG frame over the typed HTTP boundary', async () => {
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

  test('rejects malformed frame and cross-Host status evidence', async () => {
    await expect(setup({ frames: [{ ...frame(), frameId: '' }] }).service.screenshot(actor, hostId))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(setup({ frames: [{ ...frame(), capturedAt: '2026-08-12T10:00:02.000Z' }] })
      .service.screenshot(actor, hostId)).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(setup({ statusHostId: '20000000-0000-4000-8000-000000000002' })
      .service.status(actor, hostId)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  test('returns a durable uncertain outcome when the provider dispatch fails', async () => {
    const { service } = setup({ providerFailure: true });
    const request = {
      input: { kind: 'text' as const, text: 'safe text' }, operationId: 'provider-one', risk: 'standard' as const
    };
    await expect(service.operate(actor, hostId, request)).resolves.toMatchObject({
      operationId: 'provider-one', state: 'uncertain'
    });
    await expect(service.operate(actor, hostId, request)).resolves.toMatchObject({
      operationId: 'provider-one', replayed: true, state: 'uncertain'
    });
  });

  test('dispatches every supported typed operation without a shell escape hatch', async () => {
    const { inputs, service } = setup({ approved: true });
    const operations = [
      { input: { key: 'Enter', kind: 'key' as const }, operationId: 'key-one', risk: 'standard' as const },
      {
        approvalId: 'approval-one', input: { kind: 'chord' as const, keys: ['Ctrl', 'Alt', 'Delete'] },
        operationId: 'chord-one', risk: 'boot' as const
      },
      { input: { kind: 'text' as const, text: 'hello' }, operationId: 'text-one', risk: 'standard' as const },
      {
        input: { frameId: 'frame-login', kind: 'mouse_move' as const, x: 10, y: 20 },
        operationId: 'move-three', risk: 'standard' as const
      },
      {
        input: { button: 'right' as const, frameId: 'frame-login', kind: 'mouse_click' as const, x: 30, y: 40 },
        operationId: 'click-three', risk: 'standard' as const
      },
      { operationId: 'power-on-three', powerState: 'on' as const, risk: 'standard' as const },
      {
        approvalId: 'approval-one', operationId: 'power-off-three', powerState: 'off' as const,
        risk: 'boot' as const
      }
    ];
    for (const operation of operations) {
      await expect(service.operate(actor, hostId, operation)).resolves.toMatchObject({ state: 'completed' });
    }
    expect(inputs).toEqual([
      { key: 'Enter', kind: 'key' },
      { kind: 'chord', keys: ['Ctrl', 'Alt', 'Delete'] },
      { kind: 'text', text: 'hello' },
      { frameId: 'frame-login', kind: 'mouse_move', x: 10, y: 20 },
      { button: 'right', frameId: 'frame-login', kind: 'mouse_click', x: 30, y: 40 },
      { power: 'on' },
      { power: 'off' }
    ]);
  });

  test('fails closed on ambiguous Hosts and changed operation replays', async () => {
    const { service } = setup();
    await expect(service.status(actor, 'missing')).rejects.toBeInstanceOf(HostControlError);
    await service.operate(actor, hostId, {
      operationId: 'power-one', powerState: 'on', risk: 'standard'
    });
    await expect(service.operate(actor, hostId, {
      input: { kind: 'text', text: 'changed operation' },
      operationId: 'power-one', risk: 'standard'
    })).rejects.toMatchObject({ code: 'replay_conflict' });
    await expect(service.operate(actor, hostId, {
      input: { kind: 'shell', command: 'whoami' }, operationId: 'unsafe-one', risk: 'standard'
    } as never)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
