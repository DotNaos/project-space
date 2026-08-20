import { describe, expect, test } from 'bun:test';
import { isTailscaleClassificationControlDisabled } from '../src/features/project-desktop/components/compute-source-row-state';

describe('Compute source row controls', () => {
  test('disables Tailscale classification while saving as well as when unavailable', () => {
    expect(isTailscaleClassificationControlDisabled(false, false)).toBe(false);
    expect(isTailscaleClassificationControlDisabled(false, true)).toBe(true);
    expect(isTailscaleClassificationControlDisabled(true, false)).toBe(true);
    expect(isTailscaleClassificationControlDisabled(true, true)).toBe(true);
  });
});
