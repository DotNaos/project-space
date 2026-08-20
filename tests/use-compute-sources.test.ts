import { describe, expect, test } from 'bun:test';
import {
  createComputeSourceRequestGate,
  computeSourceErrorState,
  computeSourceLoadingState,
  computeSourceReadyState
} from '../src/features/project-desktop/hooks/compute-source-state';
import type { ComputeSourceState } from '../src/features/project-desktop/hooks/use-compute-sources-types';

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

  test('ignores an older completion after a newer request begins', () => {
    const gate = createComputeSourceRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });
});
