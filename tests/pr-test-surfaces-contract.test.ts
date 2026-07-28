import { describe, expect, test } from 'bun:test';

import {
  pullRequestPrototypeSurfaceKinds,
  pullRequestTestSurfaceKinds,
  type PullRequestTestSurface
} from '../src/shared/pr-preview-test-surfaces-api';
import {
  canonicalDeployedSurfaceUrl,
  canonicalTailscaleUrl
} from '../server/pr-test-surfaces/validation';
import {
  prDevServerLeaseMigrationId,
  prDevServerLeaseMigrationSql
} from '../server/database/pr-dev-server-lease-migration';

describe('PR test-surface public contract', () => {
  test('keeps the four stable surface kinds and two supported live targets', () => {
    expect(pullRequestTestSurfaceKinds).toEqual([
      'full-preview',
      'mobile-prototype',
      'desktop-prototype',
      'dev-server'
    ]);
    expect(pullRequestPrototypeSurfaceKinds).toEqual([
      'mobile-prototype',
      'desktop-prototype'
    ]);
  });

  test('represents unavailable records without a URL', () => {
    const surface: PullRequestTestSurface = {
      kind: 'dev-server',
      reasonCode: 'live-heartbeat-expired',
      state: 'stale'
    };
    expect(surface).not.toHaveProperty('url');
  });

  test('canonicalizes only exact PR deployment and Tailscale URLs', () => {
    expect(
      canonicalDeployedSurfaceUrl(
        'https://pr-356.projects.os-home.net/prototype/mobile/',
        'mobile-prototype',
        356
      )
    ).toBe('https://pr-356.projects.os-home.net/prototype/mobile/');
    expect(
      canonicalTailscaleUrl('100.80.135.9', 44_419, 'desktop-prototype')
    ).toBe('http://100.80.135.9:44419/prototype/desktop/');
    expect(() =>
      canonicalDeployedSurfaceUrl(
        'https://projects.os-home.net/prototype/mobile/',
        'mobile-prototype',
        356
      )
    ).toThrow();
    expect(() => canonicalTailscaleUrl(
      '192.168.1.4',
      44_419,
      'desktop-prototype'
    )).toThrow();
  });

  test('defines a fenced, expiring, ownership-scoped lease table', () => {
    expect(prDevServerLeaseMigrationId).toBe('0025_pr_dev_server_leases');
    expect(prDevServerLeaseMigrationSql).toContain(
      'create table pull_request_dev_server_leases'
    );
    expect(prDevServerLeaseMigrationSql).toContain(
      'pull_request_dev_server_leases_current_scope_idx'
    );
    expect(prDevServerLeaseMigrationSql).toContain('lease_generation bigint');
    expect(prDevServerLeaseMigrationSql).toContain('expires_at timestamptz');
    expect(prDevServerLeaseMigrationSql).toContain(
      'foreign key (connector_id, owner_user_id)'
    );
    expect(prDevServerLeaseMigrationSql).toContain(
      'foreign key (physical_machine_id, owner_user_id)'
    );
  });
});
