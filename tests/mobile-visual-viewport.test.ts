import { describe, expect, test } from 'bun:test';

import { visualViewportBottomInset } from '../src/features/project-desktop/components/mobile-visual-viewport';

describe('mobile visual viewport inset', () => {
  test('raises fixed controls above a software keyboard', () => {
    expect(visualViewportBottomInset({
      layoutHeight: 844,
      offsetTop: 0,
      viewportHeight: 504
    })).toBe(340);
  });

  test('accounts for browser chrome offsets and ignores invalid expansion', () => {
    expect(visualViewportBottomInset({
      layoutHeight: 844,
      offsetTop: 44,
      viewportHeight: 500
    })).toBe(300);
    expect(visualViewportBottomInset({
      layoutHeight: 700,
      offsetTop: 0,
      viewportHeight: 720
    })).toBe(0);
    expect(visualViewportBottomInset({
      layoutHeight: Number.NaN,
      offsetTop: 0,
      viewportHeight: 500
    })).toBe(0);
  });
});
