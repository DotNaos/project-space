import { describe, expect, test } from 'bun:test';

import { shouldDefaultContextPanelOpen } from '../src/features/project-desktop/components/project-desktop-viewport';

describe('project desktop shell viewport defaults', () => {
  test('keeps the context panel closed in iPad portrait and open on wide screens', () => {
    expect(shouldDefaultContextPanelOpen(1024)).toBe(false);
    expect(shouldDefaultContextPanelOpen(1180)).toBe(true);
    expect(shouldDefaultContextPanelOpen(1366)).toBe(true);
    expect(shouldDefaultContextPanelOpen(Number.NaN)).toBe(false);
  });
});
