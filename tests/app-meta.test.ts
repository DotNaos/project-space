import { describe, expect, test } from 'bun:test';

import { resolveAppVersion } from '../server/app-meta';

describe('app metadata version', () => {
  test('uses the explicit deployed build version first', () => {
    expect(resolveAppVersion({
      buildVersion: ' 0.20.0 ',
      gitReleaseTag: 'v0.19.0',
      packageVersion: '0.4.66'
    })).toBe('0.20.0');
  });

  test('uses the latest reachable release tag for a local checkout', () => {
    expect(resolveAppVersion({
      gitReleaseTag: 'v0.19.0',
      packageVersion: '0.4.66'
    })).toBe('0.19.0');
  });

  test('falls back to the package version when no stable release tag exists', () => {
    expect(resolveAppVersion({
      gitReleaseTag: 'preview-42',
      packageVersion: '0.4.66'
    })).toBe('0.4.66');
  });
});
