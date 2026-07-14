import { describe, expect, test } from 'bun:test';

import {
  registeredDevServerUrl,
  visibleTailscaleUrl
} from '../src/features/project-desktop/components/worktree-dev-server-model';
import type { WorktreeDevServerRecord } from '../src/shared/project-space-api';

function server(overrides: Partial<WorktreeDevServerRecord> = {}): WorktreeDevServerRecord {
  return {
    capability: 'configured',
    checkedAt: '2026-07-14T00:00:00.000Z',
    machineId: 'machine-1',
    projectId: 'project-1',
    publicPort: 4173,
    runTarget: 'web',
    serverId: 'web',
    serverLabel: 'Web',
    state: 'running',
    tailscaleIPv4: '100.87.34.51',
    tailscaleUrl: 'http://100.87.34.51:4173/',
    verifiedAt: '2026-07-14T00:00:00.000Z',
    worktreeId: 'wt_111111111111111111111111',
    ...overrides
  };
}

describe('worktree development server URL model', () => {
  test('keeps a canonical registered URL openable after freshness expires', () => {
    const record = server({ state: 'stopped' });
    expect(registeredDevServerUrl(record)).toBe('http://100.87.34.51:4173/');
    expect(visibleTailscaleUrl(record, Date.parse('2026-07-14T00:00:01.000Z'))).toBeUndefined();
  });

  test('opens only a fresh URL matching the verified Tailscale exposure', () => {
    const now = Date.parse('2026-07-14T00:00:10.000Z');
    expect(visibleTailscaleUrl(server(), now)).toBe('http://100.87.34.51:4173/');
    expect(visibleTailscaleUrl(server({ publicPort: 5173 }), now)).toBeUndefined();
    expect(visibleTailscaleUrl(server({ tailscaleIPv4: '192.168.1.5' }), now)).toBeUndefined();
  });

  test('rejects credential-bearing registered URLs', () => {
    expect(
      registeredDevServerUrl(server({ tailscaleUrl: 'https://user:secret@example.test/' }))
    ).toBeUndefined();
  });

  test('rejects registered URLs that do not exactly match the trusted exposure', () => {
    expect(registeredDevServerUrl(server({ tailscaleUrl: 'https://100.87.34.51:4173/' }))).toBeUndefined();
    expect(registeredDevServerUrl(server({ tailscaleUrl: 'http://example.test:4173/' }))).toBeUndefined();
    expect(registeredDevServerUrl(server({ tailscaleUrl: 'http://100.87.34.51:4173/admin' }))).toBeUndefined();
    expect(registeredDevServerUrl(server({ tailscaleUrl: 'http://100.87.34.51:4173/?token=x' }))).toBeUndefined();
  });
});
