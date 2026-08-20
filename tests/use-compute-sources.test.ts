import { describe, expect, test } from 'bun:test';
import {
  createComputeSourceRequestGate,
  computeSourceErrorState,
  computeSourceLoadingState,
  computeSourceReadyState,
  computeTailscaleSourceErrorState,
  mergeTailscaleRefreshResult
} from '../src/features/project-desktop/hooks/compute-source-state';
import type { ComputeSourceState } from '../src/features/project-desktop/hooks/use-compute-sources-types';
import type { TailscaleInventoryResult } from '../src/shared/tailscale-inventory-api';

describe('useComputeSources state transitions', () => {
  test('distinguishes initial loading from refresh loading', () => {
    const initial: ComputeSourceState<{ count: number }> = { error: '', status: 'loading' };
    const ready: ComputeSourceState<{ count: number }> = { error: '', result: { count: 1 }, status: 'ready' };

    expect(computeSourceLoadingState(initial)).toEqual({ error: '', status: 'loading' });
    expect(computeSourceLoadingState(ready)).toEqual({ error: '', result: { count: 1 }, status: 'refreshing' });
  });

  test('retains last-known data when a refresh fails', () => {
    const ready: ComputeSourceState<{ count: number }> = { error: '', result: { count: 1 }, status: 'ready' };
    const failed = computeSourceErrorState(ready, 'Provider unavailable.');

    expect(computeSourceReadyState({ count: 2 })).toEqual({ error: '', result: { count: 2 }, status: 'ready' });
    expect(failed).toEqual({ error: 'Provider unavailable.', result: { count: 1 }, status: 'error' });
  });

  test('projects cached Tailscale rows to unknown when transport refresh fails', () => {
    const ready: ComputeSourceState<TailscaleInventoryResult> = {
      error: '',
      result: {
        devices: [{
          addresses: ['100.64.0.1'],
          classification: 'unclassified',
          id: 'device-a',
          name: 'device-a',
          network: { checkedAt: '2026-08-20T00:00:00.000Z', freshUntil: '2026-08-20T00:01:00.000Z', state: 'online' },
          revision: 1,
          tags: []
        }],
        provider: { connectionState: 'connected', refreshState: 'available', source: 'tailscale_oauth_api' },
        schemaVersion: 1
      },
      status: 'ready'
    };
    const failed = computeTailscaleSourceErrorState(ready, 'Provider unavailable.');

    expect(failed.status).toBe('error');
    expect(failed.result?.devices[0]?.network.state).toBe('unknown');
    expect(failed.result?.provider.refreshState).toBe('unavailable');
  });

  test('keeps a classification mutation newer than an older refresh response', () => {
    const fetched = {
      addresses: ['100.64.0.1'],
      classification: 'unclassified' as const,
      id: 'device-a',
      network: { checkedAt: '2026-08-20T00:00:00.000Z', freshUntil: '2026-08-20T00:01:00.000Z', state: 'online' as const },
      revision: 3,
      tags: []
    };
    const locallySaved = {
      ...fetched,
      classification: 'environment' as const,
      revision: 4
    };
    const refreshed = mergeTailscaleRefreshResult(
      { devices: [locallySaved], provider: { connectionState: 'connected', refreshState: 'available', source: 'tailscale_oauth_api' }, schemaVersion: 1 },
      { devices: [fetched], provider: { connectionState: 'connected', refreshState: 'available', source: 'tailscale_oauth_api' }, schemaVersion: 1 }
    );

    expect(refreshed.devices[0]).toMatchObject({ classification: 'environment', revision: 4 });
  });

  test('ignores an older completion after a newer request begins', () => {
    const gate = createComputeSourceRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });
});
