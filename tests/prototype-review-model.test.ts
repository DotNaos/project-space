import { describe, expect, test } from 'bun:test';

import type { PullRequestTestSurfacesResult } from '../src/shared/pr-preview-test-surfaces-api';
import {
  developmentPrototypeTarget,
  embeddedPrototypeUrl,
  feedbackMatchesTarget,
  isIsolatedPrototypeTarget,
  parsePrototypeReviewRoute,
  verifiedPrototypeTarget
} from '../src/features/pr-preview-review/prototype-review-model';

const result: PullRequestTestSurfacesResult = {
  checkedAt: '2026-07-28T10:00:00.000Z',
  feedback: {
    state: 'available',
    threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0',
    verifiedAt: '2026-07-28T10:00:00.000Z'
  },
  headSha: 'a'.repeat(40),
  liveContext: {
    connectorId: 'connector-os-mac',
    heartbeatAt: '2026-07-28T10:00:00.000Z',
    leaseExpiresAt: '2026-07-28T10:01:00.000Z',
    machineId: 'os-mac',
    servedSurface: 'desktop-prototype',
    state: 'available',
    verifiedAt: '2026-07-28T10:00:00.000Z'
  },
  pullRequestNumber: 356,
  repositoryFullName: 'DotNaos/project-space',
  surfaces: [
    {
      commitSha: 'a'.repeat(40),
      connectorId: 'connector-os-mac',
      kind: 'dev-server',
      leaseExpiresAt: '2026-07-28T10:01:00.000Z',
      machineId: 'os-mac',
      servedSurface: 'desktop-prototype',
      source: 'live',
      state: 'available',
      url: 'https://os-mac.example.ts.net/prototype/desktop/',
      verifiedAt: '2026-07-28T10:00:00.000Z'
    },
    {
      commitSha: 'a'.repeat(40),
      kind: 'desktop-prototype',
      source: 'deployed',
      state: 'available',
      url: 'https://pr-356.projects-os-home.net/prototype/desktop/',
      verifiedAt: '2026-07-28T09:55:00.000Z'
    },
    {
      commitSha: 'a'.repeat(40),
      kind: 'mobile-prototype',
      source: 'deployed',
      state: 'available',
      url: 'https://pr-356.projects-os-home.net/prototype/mobile/',
      verifiedAt: '2026-07-28T09:55:00.000Z'
    }
  ]
};

describe('prototype review model', () => {
  test('parses a bounded review route', () => {
    expect(parsePrototypeReviewRoute(
      '/prototype-review',
      '?repository=DotNaos%2Fproject-space&pr=356&surface=native&viewport=tablet&scenario=offline&orientation=landscape&theme=light'
    )).toMatchObject({
      matches: true,
      orientation: 'landscape',
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space',
      scenario: 'offline',
      surface: 'native',
      theme: 'light',
      viewport: 'tablet'
    });
  });

  test('prefers an exact live surface over the deployed surface', () => {
    const target = verifiedPrototypeTarget(result, 'web');
    expect(target).toEqual({
      source: 'live',
      surfaceKind: 'desktop-prototype',
      url: 'https://os-mac.example.ts.net/prototype/desktop/'
    });
    expect(feedbackMatchesTarget(result, target)).toBe(true);
  });

  test('uses deployed native without exposing feedback', () => {
    const target = verifiedPrototypeTarget(result, 'native');
    expect(target?.source).toBe('deployed');
    expect(target?.surfaceKind).toBe('mobile-prototype');
    expect(feedbackMatchesTarget(result, target)).toBe(false);
  });

  test('accepts only local development overrides and preserves surface switching', () => {
    const target = developmentPrototypeTarget(
      'http://prototype.localhost:1355/prototype/desktop/?scenario=ready',
      'http://review.localhost:1355/prototype-review',
      'native'
    );
    expect(target?.url).toStartWith(
      'http://prototype.localhost:1355/prototype/mobile/'
    );
    expect(developmentPrototypeTarget(
      'https://example.com/prototype/desktop/',
      'http://review.localhost:1355/prototype-review',
      'web'
    )).toBeUndefined();
  });

  test('adds only presentation context to the verified target URL', () => {
    const target = verifiedPrototypeTarget(result, 'web');
    expect(target).toBeDefined();
    const url = new URL(
      embeddedPrototypeUrl(
        target!,
        'long-content',
        'desktop',
        'landscape',
        'light'
      )
    );
    expect(url.searchParams.get('embedded')).toBe('1');
    expect(url.searchParams.get('scenario')).toBe('long-content');
    expect(url.searchParams.get('viewport')).toBe('desktop');
    expect(url.searchParams.get('orientation')).toBe('landscape');
    expect(url.searchParams.get('theme')).toBe('light');
    expect(url.searchParams.has('fullscreen')).toBe(false);
    expect(url.searchParams.has('frame')).toBe(false);
  });

  test('withholds a same-origin target before granting script and origin privileges', () => {
    const target = verifiedPrototypeTarget(result, 'web');
    expect(isIsolatedPrototypeTarget(
      target,
      'https://projects.os-home.net/prototype-review'
    )).toBe(true);
    expect(isIsolatedPrototypeTarget(
      { ...target!, url: 'https://projects.os-home.net/prototype/desktop/' },
      'https://projects.os-home.net/prototype-review'
    )).toBe(false);
  });
});
