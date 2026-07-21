import { describe, expect, test } from 'bun:test';
import type { MachineRecord } from '../src/shared/project-space-api';
import {
  aggregateCodexInventoryTruth,
  CODEX_SESSIONS_CONNECTOR_CAPABILITY,
  codexInventoryTruth,
  type CodexInventoryTruth
} from '../src/features/codex-sessions/codex-inventory-truth';
import type { CodexMachine } from '../src/features/codex-sessions/codex-sessions-types';

function connector(
  overrides: Partial<MachineRecord['connector']> = {}
): MachineRecord {
  return {
    connector: {
      capabilities: [CODEX_SESSIONS_CONNECTOR_CAPABILITY],
      installCommand: 'project connector install',
      runtime: {
        architecture: 'arm64',
        buildId: '0'.repeat(40),
        bundleVersions: {
          connector: '0.4.10',
          machineTools: '0.4.10',
          projectCli: '0.4.10'
        },
        channel: 'stable',
        instanceId: 'connector-instance-current',
        lastCheckedAt: '2026-07-21T00:00:00.000Z',
        platform: 'darwin',
        protocolVersion: '2',
        releaseId: 'v0.4.10',
        source: 'managed',
        version: '0.4.10'
      },
      status: 'online',
      update: { state: 'up-to-date' },
      ...overrides
    },
    id: 'machine-mac',
    kind: 'connector',
    name: 'os-macbook',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function inventory(overrides: Partial<CodexMachine> = {}): CodexMachine {
  return {
    id: 'machine-mac',
    inventoryCheckedAt: '2026-07-21T00:01:00.000Z',
    inventoryConnectorInstanceId: 'connector-instance-current',
    inventoryPublishedAt: new Date().toISOString(),
    inventoryState: 'live',
    name: 'os-macbook',
    status: 'connected',
    ...overrides
  };
}

describe('Codex inventory truth gate', () => {
  test('starts in Checking while connector evidence is loading', () => {
    expect(codexInventoryTruth({ loading: true })).toEqual({
      detail: 'Checking the authenticated connector and its Codex support.',
      label: 'Checking',
      state: 'checking'
    });
  });

  test('blocks an offline connector instead of treating its inventory as empty', () => {
    expect(codexInventoryTruth({
      connector: connector({ status: 'offline' }),
      inventory: inventory({ inventoryState: 'stale', status: 'offline' })
    }).state).toBe('blocked');
  });

  test('distinguishes a missing capability that can be updated from one that is blocked', () => {
    const updateRequired = codexInventoryTruth({
      connector: connector({
        capabilities: ['runtime.update'],
        update: {
          availableReleaseId: 'v0.4.10',
          availableVersion: '0.4.10',
          state: 'update-available'
        }
      })
    });
    const blocked = codexInventoryTruth({
      connector: connector({
        capabilities: ['runtime.update'],
        update: { state: 'unsupported' }
      })
    });

    expect(updateRequired.state).toBe('update-required');
    expect(updateRequired.label).toBe('Update required');
    expect(blocked.state).toBe('blocked');
    expect(blocked.detail).toContain('cannot be updated');
  });

  test('reports an update in progress before evaluating inventory evidence', () => {
    expect(codexInventoryTruth({
      connector: connector({ update: { state: 'updating' } }),
      inventory: inventory()
    }).state).toBe('updating');
  });

  test('reports a restart in progress before evaluating inventory evidence', () => {
    expect(codexInventoryTruth({
      connector: connector({ update: { state: 'restarting' } }),
      inventory: inventory()
    }).state).toBe('restarting');
  });

  test('becomes Ready only for live inventory from the current runtime instance', () => {
    expect(codexInventoryTruth({
      connector: connector(),
      inventory: inventory()
    })).toEqual({
      detail: 'A compatible connector returned a current Codex inventory.',
      label: 'Ready',
      state: 'ready'
    });
  });

  test('does not reuse fresh empty inventory without current Codex capability evidence', () => {
    const result = codexInventoryTruth({
      connector: connector({ capabilities: ['runtime.update'] }),
      inventory: inventory()
    });

    expect(result.state).toBe('blocked');
    expect(result.detail).toContain('has not advertised Codex session support');
  });

  test('does not let retained runtime capabilities override the current connector overview', () => {
    const result = codexInventoryTruth({
      connector: connector({ capabilities: [] }),
      inventory: inventory(),
      runtime: {
        capabilities: [CODEX_SESSIONS_CONNECTOR_CAPABILITY],
        machineId: 'machine-mac',
        online: true,
        runtime: connector().connector.runtime,
        update: { state: 'up-to-date' }
      }
    });

    expect(result.state).toBe('blocked');
    expect(result.detail).toContain('has not advertised Codex session support');
  });

  test('expires prior live evidence instead of preserving a false empty state', () => {
    const publishedAt = '2026-07-21T00:01:00.000Z';
    const result = codexInventoryTruth({
      connector: connector(),
      inventory: inventory({ inventoryPublishedAt: publishedAt }),
      now: new Date('2026-07-21T00:01:16.000Z')
    });

    expect(result.state).toBe('checking');
    expect(result.detail).toContain('no longer fresh');
  });

  test('blocks stale inventory even when saved sessions are available', () => {
    const result = codexInventoryTruth({
      connector: connector(),
      inventory: inventory({
        inventoryState: 'stale',
        status: 'offline',
        statusDetail: 'Saved inventory from the previous connection.'
      })
    });

    expect(result.state).toBe('blocked');
    expect(result.detail).toBe('Saved inventory from the previous connection.');
  });

  test('returns to Checking when the live inventory belongs to a previous runtime instance', () => {
    const result = codexInventoryTruth({
      connector: connector(),
      inventory: inventory({ inventoryConnectorInstanceId: 'connector-instance-previous' })
    });

    expect(result.state).toBe('checking');
    expect(result.detail).toContain('connector changed');
  });

  test('blocks old live evidence when the connector is absent from an authoritative overview', () => {
    const result = codexInventoryTruth({
      connectorRequired: true,
      inventory: inventory()
    });

    expect(result.state).toBe('blocked');
    expect(result.detail).toContain('not present');
  });

  test('authoritative connector removal overrides retained maintenance state', () => {
    const result = codexInventoryTruth({
      connectorRequired: true,
      inventory: inventory(),
      runtime: {
        capabilities: [CODEX_SESSIONS_CONNECTOR_CAPABILITY],
        machineId: 'machine-mac',
        online: true,
        runtime: connector().connector.runtime,
        update: { state: 'updating' }
      }
    });

    expect(result.state).toBe('blocked');
    expect(result.detail).toContain('not present');
  });

  test('lets an active overview restart override older runtime status', () => {
    const result = codexInventoryTruth({
      connector: connector({
        runtime: {
          ...connector().connector.runtime!,
          instanceId: 'connector-instance-new'
        },
        update: { state: 'restarting' }
      }),
      inventory: inventory(),
      runtime: {
        capabilities: [CODEX_SESSIONS_CONNECTOR_CAPABILITY],
        machineId: 'machine-mac',
        online: true,
        runtime: connector().connector.runtime,
        update: { state: 'up-to-date' }
      }
    });

    expect(result.state).toBe('restarting');
    expect(result.state).not.toBe('ready');
  });

  test('returns to Checking when otherwise-current sources name different instances', () => {
    const result = codexInventoryTruth({
      connector: connector({
        runtime: {
          ...connector().connector.runtime!,
          instanceId: 'connector-instance-new'
        }
      }),
      inventory: inventory(),
      runtime: {
        capabilities: [CODEX_SESSIONS_CONNECTOR_CAPABILITY],
        machineId: 'machine-mac',
        online: true,
        runtime: connector().connector.runtime,
        update: { state: 'up-to-date' }
      }
    });

    expect(result.state).toBe('checking');
    expect(result.detail).toContain('connector changed');
  });

  test('a mixed-machine aggregate cannot claim Ready or genuine Empty', () => {
    const values: CodexInventoryTruth[] = [
      codexInventoryTruth({ connector: connector(), inventory: inventory() }),
      codexInventoryTruth({ connector: connector({ status: 'offline' }) })
    ];

    const aggregate = aggregateCodexInventoryTruth(values);
    expect(aggregate.state).toBe('blocked');
    expect(aggregate.state).not.toBe('ready');
  });
});
