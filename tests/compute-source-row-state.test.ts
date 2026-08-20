import { describe, expect, test } from 'bun:test';
import {
  canClearTailscaleRowError,
  createTailscaleRowErrorRefreshState,
  isTailscaleClassificationControlDisabled,
  shouldClearTailscaleRowErrorOnRevision
} from '../src/features/project-desktop/components/compute-source-row-state';

describe('Compute source row controls', () => {
  test('disables Tailscale classification while saving as well as when unavailable', () => {
    expect(isTailscaleClassificationControlDisabled(false, false)).toBe(false);
    expect(isTailscaleClassificationControlDisabled(false, true)).toBe(true);
    expect(isTailscaleClassificationControlDisabled(true, false)).toBe(true);
    expect(isTailscaleClassificationControlDisabled(true, true)).toBe(true);
  });

  test('clears a row error only after a proven provider refresh includes the device', () => {
    const result = {
      devices: [{ id: 'device-a', revision: 4 }],
      provider: { refreshState: 'available' }
    } as never;

    expect(canClearTailscaleRowError(result, 'device-a', 3)).toBe(true);
    expect(canClearTailscaleRowError({ ...result, provider: { refreshState: 'not_checked' } }, 'device-a', 3)).toBe(false);
    expect(canClearTailscaleRowError(result, 'device-missing', 3)).toBe(false);
  });

  test('clears a failed-save row error when a newer proven revision arrives', () => {
    expect(shouldClearTailscaleRowErrorOnRevision(3, 4, true)).toBe(true);
    expect(shouldClearTailscaleRowErrorOnRevision(3, 4, false)).toBe(false);
    expect(shouldClearTailscaleRowErrorOnRevision(4, 4, true)).toBe(true);
    expect(shouldClearTailscaleRowErrorOnRevision(4, 3, true)).toBe(false);
  });

  test('does not let a refresh begun before a failed save clear the new error', () => {
    const state = createTailscaleRowErrorRefreshState();
    state.observeRefreshGeneration(7);
    state.observeRefreshGeneration(8);
    state.recordFailedSave();

    expect(state.shouldClear(4, 4, true)).toBe(false);

    state.observeRefreshGeneration(9);
    expect(state.shouldClear(4, 4, true)).toBe(true);
    expect(state.shouldClear(4, 4, false)).toBe(false);
  });
});
