import { describe, expect, test } from 'bun:test';

import { shouldLoadGitHubCatalog } from '../src/features/project-desktop/hooks/project-desktop-routing';

describe('Project desktop GitHub catalog lifecycle', () => {
  test('loads the account on catalog and settings views', () => {
    expect(shouldLoadGitHubCatalog('projects')).toBe(true);
    expect(shouldLoadGitHubCatalog('settings')).toBe(true);
  });

  test('does not fetch the catalog for unrelated views', () => {
    expect(shouldLoadGitHubCatalog('machines')).toBe(false);
    expect(shouldLoadGitHubCatalog('project')).toBe(false);
  });
});
