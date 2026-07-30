import { describe, expect, test } from 'bun:test';
import { branchHeadComparisonPresentation } from '../src/features/project-desktop/components/branch-head-comparison-model';

describe('branch head comparison presentation', () => {
  test('labels all four states and makes behind or diverged actionable', () => {
    expect(branchHeadComparisonPresentation({
      aheadBy: 0,
      behindBy: 0,
      state: 'up-to-date'
    })).toEqual({
      actionRequired: false,
      label: 'Up to date',
      tone: 'success'
    });
    expect(branchHeadComparisonPresentation({
      aheadBy: 3,
      behindBy: 0,
      state: 'ahead'
    }).label).toBe('Ahead by 3');
    expect(branchHeadComparisonPresentation({
      aheadBy: 0,
      behindBy: 2,
      state: 'behind'
    })).toEqual({
      actionRequired: true,
      label: 'Behind by 2 — action required',
      tone: 'warning'
    });
    expect(branchHeadComparisonPresentation({
      aheadBy: 4,
      behindBy: 2,
      state: 'diverged'
    })).toEqual({
      actionRequired: true,
      label: 'Diverged — 4 ahead, 2 behind; action required',
      tone: 'warning'
    });
  });
});
