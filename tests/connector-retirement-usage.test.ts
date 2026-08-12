import { describe, expect, test } from 'bun:test';

import {
  connectorResponsibilityIds,
  type ConnectorResponsibilityId
} from '../src/shared/connector-retirement-ledger';
import {
  connectorCompatibilityCatalogIsComplete,
  connectorCompatibilityCatalogVersion,
  connectorCompatibilitySurfaces,
  type ConnectorCompatibilityUsageStore,
  type ConnectorReplacementProof
} from '../server/connector-retirement/contracts';
import { MemoryConnectorCompatibilityUsageStore } from '../server/connector-retirement/memory-store';
import { PostgresConnectorCompatibilityUsageStore } from '../server/connector-retirement/postgres-store';
import { ConnectorRetirementService } from '../server/connector-retirement/service';
import { configuredConnectorRetirementConfig } from '../server/connector-retirement/configured-runtime';

const ownerUserId = 'owner-one';
const windowStart = '2026-07-01T00:00:00.000Z';
const checkedAt = '2026-08-01T00:00:00.000Z';

function proofs(value = true) {
  return Object.fromEntries(connectorResponsibilityIds.map((id) => [id, {
    deployedRevision: value ? 'a'.repeat(40) : '',
    rollbackDrillAt: value ? '2026-06-01T00:00:00.000Z' : '',
    runtimeProofRef: value ? `https://projects.os-home.net/proofs/${id}` : ''
  }])) as Record<ConnectorResponsibilityId, ConnectorReplacementProof>;
}

function service(
  store = new MemoryConnectorCompatibilityUsageStore(),
  overrides: Record<string, unknown> = {}
) {
  return new ConnectorRetirementService(store, {
    deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
    failureContractReleased: true,
    legacyGlobalCredentialDisabled: true,
    maximumEvidenceAgeSeconds: 32 * 24 * 60 * 60,
    observationStartedAt: windowStart,
    replacementProofs: proofs(),
    replacementProofsVerified: true,
    requiredObservationSeconds: 30 * 24 * 60 * 60,
    ...overrides
  }, () => new Date(checkedAt));
}

describe('Connector compatibility usage evidence', () => {
  test('classifies every ledger responsibility exactly through a bounded surface', () => {
    expect(connectorCompatibilityCatalogIsComplete()).toBe(true);
    expect(new Set(connectorCompatibilitySurfaces.map(({ responsibilityId }) =>
      responsibilityId
    ))).toEqual(new Set(connectorResponsibilityIds));
    expect(new Set(connectorCompatibilitySurfaces.map(({ id }) => id)).size)
      .toBe(connectorCompatibilitySurfaces.length);
  });

  test('counts only authorized, non-replayed successful classified use', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    const retirement = service(store);
    const common = {
      completedAt: '2026-07-02T00:00:00.000Z',
      ownerUserId,
      replayed: false
    };
    expect(await retirement.record({
      ...common, authorized: false, outcome: 'succeeded', surface: 'connector.command.remote.v2'
    })).toBe(false);
    expect(await retirement.record({
      ...common, authorized: true, outcome: 'failed', surface: 'connector.command.remote.v2'
    })).toBe(false);
    expect(await retirement.record({
      ...common, authorized: true, outcome: 'succeeded', replayed: true,
      surface: 'connector.command.remote.v2'
    })).toBe(false);
    expect(await retirement.record({
      ...common, authorized: true, outcome: 'succeeded', surface: '/unknown?token=secret'
    })).toBe(false);
    expect(await retirement.record({
      ...common, authorized: true, outcome: 'succeeded', surface: 'connector.command.remote.v2'
    })).toBe(true);

    expect(await store.list(ownerUserId)).toMatchObject({
      usage: [{
        successfulUseCount: 1,
        surface: 'connector.command.remote.v2'
      }]
    });
  });

  test('aggregates concurrent successes without retaining request details', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    const retirement = service(store);
    await Promise.all(Array.from({ length: 50 }, (_, index) => retirement.record({
      authorized: true,
      completedAt: new Date(Date.parse(windowStart) + index * 1000).toISOString(),
      outcome: 'succeeded',
      ownerUserId,
      replayed: false,
      surface: 'connector.dev-server.command.v1'
    })));
    const snapshot = await store.list(ownerUserId);
    expect(snapshot.usage).toEqual([{
      firstSuccessfulUseAt: windowStart,
      lastSuccessfulUseAt: '2026-07-01T00:00:49.000Z',
      successfulUseCount: 50,
      surface: 'connector.dev-server.command.v1'
    }]);
    expect(JSON.stringify(snapshot)).not.toContain('workspace');
    expect(JSON.stringify(snapshot)).not.toContain('token');
  });

  test('passes only with fresh complete evidence and a full zero-use window', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    const retirement = service(store);
    await store.beginRecorderSession(
      ownerUserId, 'fixture-ready', connectorCompatibilityCatalogVersion,
      windowStart, 32 * 24 * 60 * 60
    );
    await store.checkpoint(
      ownerUserId, 'fixture-ready', connectorCompatibilityCatalogVersion,
      windowStart, 32 * 24 * 60 * 60, true
    );
    await store.closeRecorderSession('fixture-ready', windowStart);
    const ready = await retirement.report(ownerUserId);
    expect(ready.gate.ready).toBe(true);
    expect(ready.unresolvedResponsibilities).toEqual([]);

    await retirement.record({
      authorized: true,
      completedAt: '2026-07-20T00:00:00.000Z',
      outcome: 'succeeded', ownerUserId, replayed: false,
      surface: 'connector.codex-sessions-control.websocket.v1'
    });
    await retirement.checkpoint(ownerUserId);
    const used = await retirement.report(ownerUserId);
    expect(used.gate.ready).toBe(false);
    expect(used.gate.requirements.zero_successful_legacy_use_for_full_window).toBe(false);
    expect(used.observation.zeroUseSince).toBe('2026-07-20T00:00:00.000Z');
  });

  test('fails closed on missing, stale, mismatched, and incomplete evidence', async () => {
    const missing = await service().report(ownerUserId);
    expect(missing.gate.ready).toBe(false);
    expect(missing.evidence).toEqual({
      complete: true,
      fresh: true,
      observedAt: checkedAt
    });
    expect(missing.gate.requirements.zero_successful_legacy_use_for_full_window).toBe(false);

    const staleStore: ConnectorCompatibilityUsageStore = {
      beginRecorderSession: async () => {}, checkpoint: async () => {},
      closeRecorderSession: async () => {}, listObservedOwners: async () => [],
      list: async () => ({
        observation: {
          catalogVersion: connectorCompatibilityCatalogVersion,
          continuousSince: windowStart,
          observedAt: '2026-07-31T00:00:00.000Z'
        },
        usage: []
      }),
      recordSuccess: async () => {}
    };
    expect((await service(staleStore, {
      maximumEvidenceAgeSeconds: 900
    }).report(ownerUserId)).evidence.fresh).toBe(false);

    const incompleteStore = new MemoryConnectorCompatibilityUsageStore();
    await incompleteStore.beginRecorderSession(
      ownerUserId, 'fixture-incomplete', connectorCompatibilityCatalogVersion, checkedAt, 900
    );
    await incompleteStore.checkpoint(
      ownerUserId, 'fixture-incomplete', connectorCompatibilityCatalogVersion,
      checkedAt, 900, true
    );
    await incompleteStore.closeRecorderSession('fixture-incomplete', checkedAt);
    const incomplete = await service(incompleteStore, {
      failureContractReleased: false,
      replacementProofs: proofs(false)
    }).report(ownerUserId);
    expect(incomplete.gate.ready).toBe(false);
    expect(incomplete.unresolvedResponsibilities).toHaveLength(connectorResponsibilityIds.length);

    const mismatch = new ConnectorRetirementService({
      beginRecorderSession: async () => {},
      checkpoint: async () => {},
      closeRecorderSession: async () => {},
      list: async () => ({
        observation: {
          catalogVersion: 'ambiguous-catalog',
          continuousSince: windowStart,
          observedAt: checkedAt
        },
        usage: []
      }),
      listObservedOwners: async () => [],
      recordSuccess: async () => {}
    }, {
      deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
      failureContractReleased: true,
      legacyGlobalCredentialDisabled: true,
      maximumEvidenceAgeSeconds: 900,
      observationStartedAt: windowStart,
      replacementProofs: proofs(),
      replacementProofsVerified: true,
      requiredObservationSeconds: 30 * 24 * 60 * 60
    }, () => new Date(checkedAt));
    expect((await mismatch.report(ownerUserId)).evidence.complete).toBe(false);
    expect(connectorCompatibilityCatalogVersion).toBe('connector-compatibility.v1');
  });

  test('resets continuity after a recorder failure and shares the installer sunset', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    let current = new Date('2026-07-01T00:00:00.000Z');
    const retirement = new ConnectorRetirementService(store, {
      deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
      failureContractReleased: true,
      legacyGlobalCredentialDisabled: true,
      maximumEvidenceAgeSeconds: 900,
      observationStartedAt: windowStart,
      replacementProofs: proofs(),
      replacementProofsVerified: true,
      requiredObservationSeconds: 30 * 24 * 60 * 60
    }, () => current);
    await retirement.checkpoint(ownerUserId);
    current = new Date('2026-07-02T00:00:00.000Z');
    retirement.invalidate(ownerUserId);
    await retirement.checkpoint(ownerUserId);
    expect((await store.list(ownerUserId)).observation?.continuousSince)
      .toBe('2026-07-02T00:00:00.000Z');

    const sunsetEpoch = Date.parse('2026-06-30T00:00:00.000Z') / 1000;
    const configured = configuredConnectorRetirementConfig({
      PROJECT_SPACE_CONNECTOR_COMPATIBILITY_INSTALL_UNTIL_EPOCH: String(sunsetEpoch),
      PROJECT_CONNECTOR_REGISTRATION_TOKEN: 'legacy-still-enabled'
    });
    expect(configured.deprecationSunsetAt).toBe('2026-06-30T00:00:00.000Z');
    expect(configured.legacyGlobalCredentialDisabled).toBe(false);
  });

  test('preserves continuous evidence across a normal service restart', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    let current = new Date(windowStart);
    const first = new ConnectorRetirementService(store, {
      deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
      failureContractReleased: true,
      legacyGlobalCredentialDisabled: true,
      maximumEvidenceAgeSeconds: 900,
      observationStartedAt: windowStart,
      replacementProofs: proofs(),
      replacementProofsVerified: true,
      requiredObservationSeconds: 30 * 24 * 60 * 60
    }, () => current, 'recorder-first');
    await first.checkpoint(ownerUserId);
    current = new Date('2026-07-01T00:10:00.000Z');
    await first.checkpoint(ownerUserId);
    await first.close();
    const restarted = new ConnectorRetirementService(store, {
      deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
      failureContractReleased: true,
      legacyGlobalCredentialDisabled: true,
      maximumEvidenceAgeSeconds: 900,
      observationStartedAt: windowStart,
      replacementProofs: proofs(),
      replacementProofsVerified: true,
      requiredObservationSeconds: 30 * 24 * 60 * 60
    }, () => new Date('2026-07-01T00:11:00.000Z'), 'recorder-second');
    await restarted.checkpoint(ownerUserId);
    expect((await store.list(ownerUserId)).observation?.continuousSince).toBe(windowStart);
  });

  test('starts a new durable evidence epoch when owner attribution becomes complete', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    const common = {
      deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
      failureContractReleased: true,
      maximumEvidenceAgeSeconds: 32 * 24 * 60 * 60,
      observationStartedAt: windowStart,
      replacementProofs: proofs(),
      replacementProofsVerified: true,
      requiredObservationSeconds: 30 * 24 * 60 * 60
    };
    const unattributed = new ConnectorRetirementService(store, {
      ...common,
      legacyGlobalCredentialDisabled: false
    }, () => new Date(windowStart), 'recorder-before-owner-attribution');
    await unattributed.checkpoint(ownerUserId);
    await unattributed.close();

    const attributionStartedAt = '2026-08-01T00:00:00.000Z';
    const attributed = new ConnectorRetirementService(store, {
      ...common,
      legacyGlobalCredentialDisabled: true
    }, () => new Date(attributionStartedAt), 'recorder-after-owner-attribution');
    await attributed.checkpoint(ownerUserId);
    const report = await attributed.report(ownerUserId);

    expect((await store.list(ownerUserId)).observation).toMatchObject({
      catalogVersion: connectorCompatibilityCatalogVersion,
      continuousSince: attributionStartedAt
    });
    expect(report.gate.ready).toBe(false);
    expect(report.gate.requirements.owner_attribution_complete).toBe(true);
    expect(report.gate.requirements.zero_successful_legacy_use_for_full_window).toBe(false);
    expect(report.observation.zeroUseSince).toBe(attributionStartedAt);
  });

  test('resets continuity after an unclean recorder restart', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    let current = new Date(windowStart);
    const config = {
      deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
      failureContractReleased: true,
      legacyGlobalCredentialDisabled: true,
      maximumEvidenceAgeSeconds: 900,
      observationStartedAt: windowStart,
      replacementProofs: proofs(),
      replacementProofsVerified: true,
      requiredObservationSeconds: 30 * 24 * 60 * 60
    };
    const first = new ConnectorRetirementService(
      store, config, () => current, 'recorder-before-crash'
    );
    await first.checkpoint(ownerUserId);
    current = new Date('2026-07-01T00:10:00.000Z');
    const crashed = new ConnectorRetirementService(
      store, config, () => current, 'recorder-after-crash'
    );
    await crashed.checkpoint(ownerUserId);
    expect((await store.list(ownerUserId)).observation?.continuousSince)
      .toBe('2026-07-01T00:10:00.000Z');
  });

  test('keeps a failed recorder session unclean across an orderly shutdown', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    let current = new Date(windowStart);
    const config = {
      deprecationSunsetAt: '2026-06-30T00:00:00.000Z',
      failureContractReleased: true,
      legacyGlobalCredentialDisabled: true,
      maximumEvidenceAgeSeconds: 900,
      observationStartedAt: windowStart,
      replacementProofs: proofs(),
      replacementProofsVerified: true,
      requiredObservationSeconds: 30 * 24 * 60 * 60
    };
    const first = new ConnectorRetirementService(
      store, config, () => current, 'recorder-before-write-failure'
    );
    await first.checkpoint(ownerUserId);
    first.invalidate(ownerUserId);
    await first.close();
    current = new Date('2026-07-01T00:10:00.000Z');
    const restarted = new ConnectorRetirementService(
      store, config, () => current, 'recorder-after-write-failure'
    );
    await restarted.checkpoint(ownerUserId);
    expect((await store.list(ownerUserId)).observation?.continuousSince)
      .toBe('2026-07-01T00:10:00.000Z');
  });

  test('serializes a report behind an in-flight successful-use write', async () => {
    let releaseWrite = () => {};
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    class DelayedStore extends MemoryConnectorCompatibilityUsageStore {
      override async recordSuccess(...input: Parameters<MemoryConnectorCompatibilityUsageStore['recordSuccess']>) {
        markStarted();
        await writeStarted;
        return super.recordSuccess(...input);
      }
    }
    const retirement = service(new DelayedStore());
    const recording = retirement.record({
      authorized: true,
      completedAt: checkedAt,
      outcome: 'succeeded',
      ownerUserId,
      replayed: false,
      surface: 'connector.command.remote.v2'
    });
    await started;
    let reportSettled = false;
    const report = retirement.report(ownerUserId).finally(() => {
      reportSettled = true;
    });
    await Promise.resolve();
    expect(reportSettled).toBe(false);
    releaseWrite();
    await recording;
    expect((await report).usage.find(({ surface }) =>
      surface === 'connector.command.remote.v2')?.successfulUseCount).toBe(1);
  });

  test('does not trust self-asserted replacement proof configuration', async () => {
    const store = new MemoryConnectorCompatibilityUsageStore();
    const retirement = service(store, { replacementProofsVerified: false });
    await retirement.checkpoint(ownerUserId);
    const report = await retirement.report(ownerUserId);
    expect(report.gate.ready).toBe(false);
    expect(report.gate.requirements.all_replacements_deployed).toBe(false);
    expect(report.gate.requirements.runtime_proof_complete).toBe(false);
    expect(report.gate.requirements.rollback_drill_complete).toBe(false);
    expect(report.unresolvedResponsibilities[0]?.reasons)
      .toContain('replacement_proof_unverified');
  });

  test('Postgres persistence stores only owner, classified surface, counter, and timestamps', async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const store = new PostgresConnectorCompatibilityUsageStore({
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes('returning owner_user_id')) return { rows: [{ owner_user_id: ownerUserId }] };
        if (sql.includes('as accepted')) return { rows: [{ accepted: 1 }] };
        return { rows: [] };
      }
    });
    await store.beginRecorderSession(
      ownerUserId, 'postgres-fixture', connectorCompatibilityCatalogVersion, windowStart, 900
    );
    await store.recordSuccess(
      ownerUserId,
      'postgres-fixture',
      connectorCompatibilityCatalogVersion,
      'connector.command.remote.v2',
      '2026-07-02T00:00:00.000Z',
      900
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]!.values).toEqual([
      ownerUserId,
      'postgres-fixture',
      'connector.command.remote.v2',
      '2026-07-02T00:00:00.000Z',
      connectorCompatibilityCatalogVersion,
      900
    ]);
    expect(calls[1]!.sql).not.toMatch(/request_body|target_id|path|token|secret|content/i);
    expect(calls[1]!.sql).toContain('successful_use_count + 1');
    await store.list(ownerUserId);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.sql).toContain('full outer join connector_compatibility_usage');
  });
});
