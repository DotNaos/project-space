import { describe, expect, test } from 'bun:test';

import { supportsLocalLauncherApps } from '../src/features/project-desktop/launcher-apps-runtime';

describe('launcher apps runtime gate', () => {
  test('only requests machine-local launcher apps for local data bindings', () => {
    expect(supportsLocalLauncherApps({
      name: 'project-space',
      platform: 'darwin',
      runtime: { apis: 'external', data: 'local', network: 'external', secrets: 'required' },
      version: 'dev'
    })).toBe(true);
    expect(supportsLocalLauncherApps({
      name: 'project-space',
      platform: 'darwin',
      runtime: { apis: 'external', data: 'remote', network: 'external', secrets: 'required' },
      version: 'dev'
    })).toBe(false);
  });
});
