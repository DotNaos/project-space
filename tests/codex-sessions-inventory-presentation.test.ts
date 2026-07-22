import { describe, expect, test } from 'bun:test';

import {
  asLiveCodexSessionInventory,
  asOfflineCodexSessionInventory,
  filterCodexSessionInventory
} from '../server/codex-sessions/inventory-presentation';
import type { CodexSessionListResult } from '../src/shared/codex-sessions-api';

const machineId = 'machine-a';

function inventory(
  overrides: Partial<CodexSessionListResult> = {}
): CodexSessionListResult {
  return {
    checkedAt: '2026-07-21T12:00:00.000Z',
    machine: { id: machineId, name: 'MacBook', online: true },
    publishedAt: '2026-07-21T12:00:01.000Z',
    sessions: [{
      archived: false,
      id: '019f831b-2b5a-72d0-952c-763b9255cae9',
      lastActivityAt: '2026-07-21T11:59:00.000Z',
      loadedByProjectSpace: true,
      machineId,
      machineName: 'MacBook',
      status: 'idle',
      title: 'Verify connector inventory'
    }],
    ...overrides
  };
}

describe('Codex session inventory presentation', () => {
  test('replaces untrusted connector evidence with hosted live evidence', () => {
    const result = asLiveCodexSessionInventory(inventory({ inventoryState: 'stale' }));

    expect(result.inventoryState).toBe('live');
    expect(result.machine.online).toBe(true);
    expect(result.sessions).toHaveLength(1);
  });

  test('marks a saved offline fallback stale and preserves that evidence through filtering', () => {
    const offline = asOfflineCodexSessionInventory(
      { id: machineId, name: 'MacBook', online: true },
      inventory().sessions,
      () => new Date('2026-07-21T12:05:00.000Z')
    );
    const filtered = filterCodexSessionInventory(offline, { machineId });

    expect(filtered.inventoryState).toBe('stale');
    expect(filtered.machine.online).toBe(false);
    expect(filtered.sessions[0]).toMatchObject({
      loadedByProjectSpace: false,
      status: 'offline'
    });
  });
});
