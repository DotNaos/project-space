import { describe, expect, test } from 'bun:test';
import { createTailscaleInventoryService, TailscaleClassificationRevisionConflict } from '../server/tailscale-inventory/service';

const base = (online = true, state: 'fresh' | 'stale' | 'unknown' = 'fresh') => ({ addresses: ['100.64.0.1'], classification: 'unclassified' as const, freshness: { observedAt: '2026-08-14T09:00:00.000Z', freshUntil: '2026-08-14T09:01:00.000Z', state }, id: 'device-a', online, revision: 0, state: 'current' as const, tags: ['tag:owner'] });
function setup() {
  const calls: unknown[] = []; let devices = [base()];
  const service = createTailscaleInventoryService({
    now: () => new Date('2026-08-14T09:02:00.000Z'),
    source: { async describe() { return { connectionState: 'connected' as const, source: 'tailscale_oauth_api' as const }; }, async observe() { return { available: true as const, snapshot: { backendState: 'running' as const, deviceErrors: [], devices: [], freshness: { freshUntil: '2026-08-14T09:01:00.000Z', observedAt: '2026-08-14T09:00:00.000Z', state: 'fresh' as const }, source: 'tailscale_status_json' as const } }; } },
    store: {
      async list(owner) { calls.push(['list', owner]); return devices; },
      async reconcile(owner, input) { calls.push(['reconcile', owner, input]); },
      async setClassification(input) { calls.push(['classify', input]); return { classification: input.classification, id: input.deviceId, revision: input.expectedRevision + 1 }; }
    }
  });
  return { calls, service, setDevices: (next: typeof devices) => { devices = next; } };
}
describe('Tailscale inventory service', () => {
  test('coalesces concurrent refreshes and briefly reuses the honest snapshot', async () => {
    let observeCalls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const storeCalls: unknown[] = [];
    const snapshot = {
      backendState: 'running' as const,
      deviceErrors: [],
      devices: [],
      freshness: {
        freshUntil: '2026-08-14T09:01:00.000Z',
        observedAt: '2026-08-14T09:00:00.000Z',
        state: 'fresh' as const
      },
      source: 'tailscale_status_json' as const
    };
    let clock = 10_000;
    const service = createTailscaleInventoryService({
      clock: () => clock,
      minimumRefreshIntervalMs: 2_000,
      source: { async describe() { return { connectionState: 'connected' as const, source: 'tailscale_oauth_api' as const }; }, async observe() { observeCalls += 1; await blocked; return { available: true as const, snapshot }; } },
      store: {
        async list() { return []; },
        async reconcile(owner, input) { storeCalls.push([owner, input]); },
        async setClassification() { throw new Error(); }
      }
    });
    const first = service.list('owner', true);
    const second = service.list('owner', true);
    await Promise.resolve();
    expect(observeCalls).toBe(1);
    release?.();
    await Promise.all([first, second]);
    await service.list('owner', true);
    expect(observeCalls).toBe(1);
    expect(storeCalls).toHaveLength(3);
    clock += 2_000;
    await service.list('owner', true);
    expect(observeCalls).toBe(2);
  });
  test('never coalesces or reuses provider evidence across owners', async () => {
    const observedOwners: string[] = [];
    const reconciled: string[] = [];
    const snapshot = {
      backendState: 'running' as const, deviceErrors: [], devices: [],
      freshness: { freshUntil: '2026-08-14T09:01:00.000Z', observedAt: '2026-08-14T09:00:00.000Z', state: 'fresh' as const },
      source: 'tailscale_api_devices' as const
    };
    const service = createTailscaleInventoryService({
      source: {
        async describe() { return { connectionState: 'connected' as const, source: 'tailscale_oauth_api' as const }; },
        async observe(owner) { observedOwners.push(owner); return { available: true as const, snapshot }; }
      },
      store: {
        async list() { return []; },
        async reconcile(owner) { reconciled.push(owner); },
        async setClassification() { throw new Error(); }
      }
    });
    await Promise.all([service.list('owner-a', true), service.list('owner-b', true)]);
    await Promise.all([service.list('owner-a', true), service.list('owner-b', true)]);
    expect(observedOwners.sort()).toEqual(['owner-a', 'owner-b']);
    expect(reconciled.sort()).toEqual(['owner-a', 'owner-a', 'owner-b', 'owner-b']);
  });
  test('shares deployment inventory and classifications while retaining the human audit actor', async () => {
    const calls: unknown[] = [];
    const audits: Array<{ actorId: string; classification: string }> = [];
    let classification = 'unclassified' as const | 'environment';
    let revision = 0;
    const snapshot = {
      backendState: 'running' as const, deviceErrors: [], devices: [],
      freshness: { freshUntil: '2026-08-14T09:01:00.000Z', observedAt: '2026-08-14T09:00:00.000Z', state: 'fresh' as const },
      source: 'tailscale_api_devices' as const
    };
    const service = createTailscaleInventoryService({
      inventoryScope: 'project-space:tailscale-deployment',
      source: {
        async describe() { return { connectionState: 'connected' as const, source: 'tailscale_oauth_api' as const }; },
        async observe(owner) { calls.push(['observe', owner]); return { available: true as const, snapshot }; }
      },
      store: {
        async list(owner) {
          calls.push(['list', owner]);
          return [{ ...base(), classification, revision }];
        },
        async reconcile(owner) { calls.push(['reconcile', owner]); },
        async setClassification(input) {
          calls.push(['classify', input]);
          if (input.expectedRevision !== revision) {
            throw new TailscaleClassificationRevisionConflict({
              classification, id: input.deviceId, revision
            });
          }
          classification = input.classification as typeof classification;
          revision += 1;
          audits.push({ actorId: input.actorId, classification });
          return { classification, id: input.deviceId, revision };
        }
      }
    });

    await service.list('user-a', true);
    await service.setClassification(
      { actorId: 'user-a', kind: 'human', ownerUserId: 'user-a' },
      'device-a',
      { classification: 'environment', expectedRevision: 0 }
    );
    const userB = await service.list('user-b');
    await expect(service.setClassification(
      { actorId: 'user-b', kind: 'human', ownerUserId: 'user-b' },
      'device-a',
      { classification: 'ignored', expectedRevision: 0 }
    )).rejects.toBeInstanceOf(TailscaleClassificationRevisionConflict);

    expect(calls).toContainEqual(['reconcile', 'project-space:tailscale-deployment']);
    expect(calls).toContainEqual(['list', 'project-space:tailscale-deployment']);
    expect(calls).toContainEqual(['classify', expect.objectContaining({
      actorId: 'user-a',
      ownerUserId: 'project-space:tailscale-deployment'
    })]);
    expect(userB.devices).toEqual([
      expect.objectContaining({ classification: 'environment', revision: 1 })
    ]);
    expect(audits).toEqual([{ actorId: 'user-a', classification: 'environment' }]);
  });
  test('fences cached evidence when the same owner rotates their connection', async () => {
    let revision = 1;
    let observeCalls = 0;
    const snapshot = {
      backendState: 'running' as const, deviceErrors: [], devices: [],
      freshness: { freshUntil: '2026-08-14T09:01:00.000Z', observedAt: '2026-08-14T09:00:00.000Z', state: 'fresh' as const },
      source: 'tailscale_api_devices' as const
    };
    const service = createTailscaleInventoryService({
      source: {
        async describe() { return { connectionId: 'connection', connectionState: 'connected' as const, revision, source: 'tailscale_oauth_api' as const }; },
        async observe() { observeCalls += 1; return { available: true as const, snapshot }; }
      },
      store: {
        async list() { return []; }, async reconcile() {}, async setClassification() { throw new Error(); }
      }
    });
    await service.list('owner', true);
    await service.list('owner', true);
    expect(observeCalls).toBe(1);
    revision = 2;
    await service.list('owner', true);
    expect(observeCalls).toBe(2);
  });
  test('reports whether a provider refresh was checked and completed', async () => {
    const fixture = setup();
    expect((await fixture.service.list('owner')).provider).toEqual({
      connectionState: 'connected', refreshState: 'not_checked', source: 'tailscale_oauth_api'
    });
    expect((await fixture.service.list('owner', true)).provider).toEqual({
      connectionState: 'connected', refreshState: 'available', source: 'tailscale_oauth_api'
    });
    expect(fixture.calls).toContainEqual([
      'reconcile',
      'owner',
      expect.objectContaining({ complete: true, kind: 'snapshot' })
    ]);
  });
  test('projects fresh provider online/offline evidence and stale cached evidence', async () => {
    const fixture = setup();
    expect((await fixture.service.list('owner')).devices[0]?.network.state).toBe('online');
    fixture.setDevices([base(false)]); expect((await fixture.service.list('owner')).devices[0]?.network.state).toBe('offline');
    fixture.setDevices([base(true, 'stale')]); expect((await fixture.service.list('owner')).devices[0]?.network.state).toBe('stale');
  });
  test('makes decoder errors partial and provider failures cached/unavailable without fabricated writes', async () => {
    const fixture = setup();
    (fixture.service as never); // source replacement is exercised by a fresh service below.
    const calls: unknown[] = []; const store = { async list() { return [base(true, 'stale')]; }, async reconcile(_: string, input: unknown) { calls.push(input); }, async setClassification() { throw new Error(); } };
    const descriptor = async () => ({ connectionState: 'connected' as const, source: 'tailscale_oauth_api' as const });
    const partial = createTailscaleInventoryService({ source: { describe: descriptor, async observe() { return { available: true as const, snapshot: { backendState: 'running' as const, deviceErrors: [{ code: 'invalid_device' as const, source: 'peer' as const }], devices: [], freshness: { freshUntil: '2026-08-14T09:01:00.000Z', observedAt: '2026-08-14T09:00:00.000Z', state: 'fresh' as const }, source: 'tailscale_status_json' as const } }; } }, store });
    expect((await partial.list('owner', true)).provider).toEqual({ connectionState: 'connected', errorCount: 1, refreshState: 'partial', source: 'tailscale_oauth_api' });
    const failed = createTailscaleInventoryService({ now: () => new Date('2026-08-14T09:02:00.000Z'), source: { describe: descriptor, async observe() { return { available: false as const, error: { code: 'command_failed' as const, source: 'command' as const } }; } }, store });
    const unavailable = await failed.list('owner', true);
    expect(unavailable.provider).toEqual({ connectionState: 'unavailable', reasonCode: 'command_failed', refreshState: 'unavailable', source: 'tailscale_oauth_api' });
    expect(unavailable.devices).toEqual([]);
    expect(calls).toHaveLength(2);
  });
  test('does not return cached devices when deployment configuration is missing or invalid', async () => {
    for (const connectionState of ['not_configured', 'configuration_error'] as const) {
      const service = createTailscaleInventoryService({
        source: {
          async describe() { return { connectionState, source: 'not_connected' as const }; },
          async observe() { throw new Error('observe must not run'); }
        },
        store: {
          async list() { return [base()]; }, async reconcile() {}, async setClassification() { throw new Error(); }
        }
      });
      expect((await service.list('owner')).devices).toEqual([]);
    }
  });
  test('requires human owner classification and preserves compare-and-swap conflicts', async () => {
    const fixture = setup();
    await expect(fixture.service.setClassification({ actorId: 'machine', kind: 'machine', ownerUserId: 'owner' }, 'device-a', { classification: 'ignored', expectedRevision: 0 })).rejects.toMatchObject({ code: 'machine-forbidden' });
    await fixture.service.setClassification({ actorId: 'owner', kind: 'human', ownerUserId: 'owner' }, 'device-a', { classification: 'environment', expectedRevision: 0 });
    expect(fixture.calls).toContainEqual(['classify', expect.objectContaining({ ownerUserId: 'owner' })]);
    const conflict = new TailscaleClassificationRevisionConflict({ classification: 'environment', id: 'device-a', revision: 1 });
    expect(conflict.name).toBe('TailscaleClassificationRevisionConflict');
  });
});
