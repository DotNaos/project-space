import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

import {
  MemoryRunnerHostAdmissionStore,
  RunnerHostAdmissionService,
  validateAdmission
} from '../server/runner-host/admission';
import type {
  RunnerHostCapacityEvidence,
  RunnerResourceVector
} from '../src/shared/runner-host-admission-api';
import { evidence, hostId, isolation, policy, request, vector } from './runner-host-admission-fixtures';

describe('VPS runner admission', () => {
  test('reserves and replays one exact sandbox identity with bounded deadlines', async () => {
    let now = Date.parse('2026-08-20T10:00:01.000Z');
    const service = new RunnerHostAdmissionService(
      new MemoryRunnerHostAdmissionStore(), policy, () => new Date(now)
    );
    const first = await service.reserve(evidence, request());
    expect(first.kind).toBe('reserved');
    if (first.kind !== 'reserved') return;
    expect(first.reservation.state).toBe('active');
    expect(first.reservation.leaseExpiresAt).toBe('2026-08-20T10:15:01.000Z');
    expect((await service.reserve(evidence, request())).kind).toBe('replayed');
    expect((await service.reserve(evidence, request('reservation-1', vector({ cpuMillis: 999 })))).kind).toBe('conflict');
    now += 1_000;
  });

  test('fails closed for missing, stale, unhealthy, or uncertain evidence', () => {
    const cases: Array<[string, RunnerHostCapacityEvidence | undefined, string]> = [
      ['missing', undefined, 'capacity_evidence_missing'],
      ['stale', { ...evidence, expiresAt: '2026-08-20T09:59:59.000Z' }, 'capacity_evidence_stale'],
      ['unhealthy', { ...evidence, productionHealth: 'unknown' }, 'production_reservation_not_proven'],
      ['uncertain', { ...evidence, cleanup: { ...evidence.cleanup, state: 'uncertain' } }, 'cleanup_uncertain']
    ];
    for (const [, candidate, reason] of cases) {
      expect(validateAdmission(candidate, request(), policy, [], new Date('2026-08-20T10:00:01.000Z'))?.reason).toBe(reason);
    }
  });

  test('reserves Production before development and limits aggregate usage', async () => {
    const store = new MemoryRunnerHostAdmissionStore();
    const service = new RunnerHostAdmissionService(store, policy, () => new Date('2026-08-20T10:00:01.000Z'));
    expect((await service.reserve(evidence, request('one'))).kind).toBe('reserved');
    expect((await service.reserve(evidence, request('two'))).kind).toBe('reserved');
    expect((await service.reserve(evidence, request('three')))).toMatchObject({
      kind: 'blocked', reason: 'concurrency_limit'
    });
    const productionExhausted = {
      ...evidence,
      capacity: {
        ...evidence.capacity,
        productionUsage: vector({ cpuMillis: 4_001 }),
        sandboxCount: 0
      }
    };
    expect(validateAdmission(productionExhausted, request(), policy, [], new Date('2026-08-20T10:00:01.000Z'))?.reason)
      .toBe('production_reservation_not_proven');
  });

  test('uses the larger of Production usage and reservation as the effective claim', () => {
    const usageBelowReservation = {
      ...evidence,
      capacity: {
        ...evidence.capacity,
        productionUsage: vector({ cpuMillis: 1_500 }),
        total: vector({ cpuMillis: 3_000, memoryBytes: 8_000, pids: 512 })
      }
    };
    expect(validateAdmission(
      usageBelowReservation, request('production-below-reservation'), policy, [],
      new Date('2026-08-20T10:00:01.000Z')
    )).toBeUndefined();

    const usageAboveReservation = {
      ...usageBelowReservation,
      capacity: {
        ...usageBelowReservation.capacity,
        productionUsage: vector({ cpuMillis: 2_500 })
      }
    };
    expect(validateAdmission(
      usageAboveReservation, request('production-above-reservation'), policy, [],
      new Date('2026-08-20T10:00:01.000Z')
    )?.reason).toBe('resource_limit');
  });

  test('binds API version, host, generation, and cleanup evidence to admission', () => {
    expect(validateAdmission(
      { ...evidence, apiVersion: 99 as never }, request(), policy, [],
      new Date('2026-08-20T10:00:01.000Z')
    )?.reason).toBe('capacity_evidence_invalid');
    expect(validateAdmission(
      { ...evidence, hostId: 'vps:other' }, request(), policy, [],
      new Date('2026-08-20T10:00:01.000Z')
    )?.reason).toBe('host_identity_mismatch');
    expect(validateAdmission(
      { ...evidence, generation: 'host-generation-2' }, request(), policy, [],
      new Date('2026-08-20T10:00:01.000Z')
    )?.reason).toBe('host_identity_mismatch');
    for (const checkedAt of ['2026-08-20T10:00:02.000Z', '2026-08-20T09:58:00.000Z']) {
      expect(validateAdmission(
        { ...evidence, cleanup: { checkedAt, state: 'proven' } }, request(), policy, [],
        new Date('2026-08-20T10:00:01.000Z')
      )?.reason).toBe('capacity_evidence_stale');
    }
  });

  test('serializes concurrent admission so the host cannot be oversubscribed', async () => {
    const service = new RunnerHostAdmissionService(
      new MemoryRunnerHostAdmissionStore(), policy, () => new Date('2026-08-20T10:00:01.000Z')
    );
    const results = await Promise.all([
      service.reserve(evidence, request('parallel-one')),
      service.reserve(evidence, request('parallel-two')),
      service.reserve(evidence, request('parallel-three'))
    ]);
    expect(results.filter(({ kind }) => kind === 'reserved')).toHaveLength(2);
    expect(results.filter(({ kind }) => kind === 'blocked')).toHaveLength(1);
  });

  test('checks every resource dimension and refuses unbounded lease windows', () => {
    for (const dimension of Object.keys(vector()) as Array<keyof RunnerResourceVector>) {
      const resources = vector();
      resources[dimension] = (policy.sandboxMaximum[dimension] ?? 0) + 1;
      expect(validateAdmission(evidence, request('limit', resources), policy, [], new Date('2026-08-20T10:00:01.000Z'))?.reason)
        .toBe('resource_limit');
    }
    expect(validateAdmission(evidence, { ...request(), maximumRuntimeSeconds: policy.maximumRuntimeSeconds + 1 }, policy, [], new Date('2026-08-20T10:00:01.000Z'))?.reason)
      .toBe('invalid_lease');
    expect(validateAdmission(evidence, {
      ...request(), isolation: { ...isolation, egress: 'open' as never }
    }, policy, [], new Date('2026-08-20T10:00:01.000Z'))?.reason).toBe('resource_limit');
  });

  test('fences uncertain cleanup and requires positive absence proof before release', async () => {
    const store = new MemoryRunnerHostAdmissionStore();
    const service = new RunnerHostAdmissionService(store, policy, () => new Date('2026-08-20T10:00:01.000Z'));
    const reserved = await service.reserve(evidence, request());
    if (reserved.kind !== 'reserved') throw new Error('fixture did not reserve');
    await service.markUncertain(hostId, reserved.reservation.identity.reservationId);
    expect((await service.reserve(evidence, request('second'))).kind).toBe('blocked');
    await expect(service.release(hostId, reserved.reservation.identity.reservationId, {
      checkedAt: '2026-08-20T10:00:02.000Z', generation: reserved.reservation.hostGeneration,
      resourcesAbsent: false as never
    })).rejects.toThrow('positive absence evidence');
    await expect(service.release(hostId, reserved.reservation.identity.reservationId, {
      checkedAt: '2026-08-20T10:00:02.000Z', generation: 'different', resourcesAbsent: true
    })).rejects.toThrow('positive absence evidence');
    await expect(service.release(hostId, reserved.reservation.identity.reservationId, {
      checkedAt: '2026-08-20T10:00:02.000Z', generation: reserved.reservation.identity.generation, resourcesAbsent: true
    })).resolves.toMatchObject({ state: 'released' });
  });

  test('fences expired idle, lease, or runtime reservations before capacity reuse', async () => {
    const store = new MemoryRunnerHostAdmissionStore();
    const service = new RunnerHostAdmissionService(store, policy, () => new Date('2026-08-20T10:00:01.000Z'));
    const reserved = await service.reserve(evidence, request());
    if (reserved.kind !== 'reserved') throw new Error('fixture did not reserve');
    const expired = {
      ...reserved.reservation,
      idleExpiresAt: '2026-08-20T09:59:59.000Z'
    };
    await store.save(hostId, expired);
    expect((await service.fenceExpired(hostId))).toHaveLength(1);
    expect((await service.reserve(evidence, request('after-expiry')))).toMatchObject({
      kind: 'blocked', reason: 'cleanup_uncertain'
    });
  });

  test('fences an expired exact replay before returning it', async () => {
    const store = new MemoryRunnerHostAdmissionStore();
    const service = new RunnerHostAdmissionService(store, policy, () => new Date('2026-08-20T10:00:01.000Z'));
    const reserved = await service.reserve(evidence, request());
    if (reserved.kind !== 'reserved') throw new Error('fixture did not reserve');
    await store.save(hostId, { ...reserved.reservation, idleExpiresAt: '2026-08-20T09:59:59.000Z' });
    const replay = await service.reserve(evidence, request());
    expect(replay).toMatchObject({ kind: 'replayed', reservation: { state: 'uncertain' } });
  });

  test('serializes expiry fencing with a racing admission', async () => {
    const store = new MemoryRunnerHostAdmissionStore();
    const service = new RunnerHostAdmissionService(store, policy, () => new Date('2026-08-20T10:00:01.000Z'));
    const reserved = await service.reserve(evidence, request());
    if (reserved.kind !== 'reserved') throw new Error('fixture did not reserve');
    await store.save(hostId, { ...reserved.reservation, idleExpiresAt: '2026-08-20T09:59:59.000Z' });
    const [, admission] = await Promise.all([
      service.fenceExpired(hostId),
      service.reserve(evidence, request('racing-expiry'))
    ]);
    expect(admission).toMatchObject({ kind: 'blocked', reason: 'cleanup_uncertain' });
  });

  test('canonicalizes request property order for exact replay', async () => {
    const store = new MemoryRunnerHostAdmissionStore();
    const service = new RunnerHostAdmissionService(store, policy, () => new Date('2026-08-20T10:00:01.000Z'));
    const original = request('canonical');
    expect((await service.reserve(evidence, original)).kind).toBe('reserved');
    const reversedResources = Object.fromEntries(Object.entries(original.resources).reverse()) as RunnerResourceVector;
    const reordered = {
      resources: reversedResources,
      maximumRuntimeSeconds: original.maximumRuntimeSeconds,
      isolation: original.isolation,
      identity: original.identity,
      idleTimeoutSeconds: original.idleTimeoutSeconds
    };
    expect((await service.reserve(evidence, reordered)).kind).toBe('replayed');
  });

  test('captures one admission timestamp through validation and persistence', async () => {
    let nowCalls = 0;
    const service = new RunnerHostAdmissionService(
      new MemoryRunnerHostAdmissionStore(),
      policy,
      () => {
        nowCalls += 1;
        return new Date('2026-08-20T10:00:01.000Z');
      }
    );
    const result = await service.reserve(evidence, request('one-timestamp'));
    expect(result.kind).toBe('reserved');
    if (result.kind !== 'reserved') return;
    expect(nowCalls).toBe(1);
    expect(result.reservation.createdAt).toBe('2026-08-20T10:00:01.000Z');
    expect(result.reservation.idleExpiresAt).toBe('2026-08-20T10:30:01.000Z');
  });

  test('keeps the checked-in VPS profile bounded and isolated', () => {
    const profile = parse(readFileSync('.project/runner.yaml', 'utf8')) as {
      capacity: { aggregateMaximum: RunnerResourceVector; productionReservation: RunnerResourceVector; sandboxMaximum: RunnerResourceVector };
      isolation: Record<string, string>;
    };
    for (const dimension of Object.keys(vector())) {
      expect(profile.capacity.sandboxMaximum[dimension as keyof RunnerResourceVector]).toBeGreaterThanOrEqual(0);
      expect(profile.capacity.aggregateMaximum[dimension as keyof RunnerResourceVector]).toBeGreaterThanOrEqual(
        profile.capacity.sandboxMaximum[dimension as keyof RunnerResourceVector]
      );
      expect(profile.capacity.productionReservation[dimension as keyof RunnerResourceVector]).toBeGreaterThanOrEqual(0);
    }
    expect(profile.isolation).toEqual({
      crossSandboxWritableVolumes: 'denied', deploymentCredentials: 'denied', dockerSocket: 'denied',
      egress: 'development', hostNetwork: 'denied', productionDatabase: 'denied',
      productionFilesystem: 'denied', sharedCaches: 'immutable-only'
    });
  });
});
