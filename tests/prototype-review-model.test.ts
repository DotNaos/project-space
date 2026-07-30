import { describe, expect, test } from 'bun:test';

import type { PullRequestTestSurfacesResult } from '../src/shared/pr-preview-test-surfaces-api';
import type { PrototypeReviewLocalContext } from '../src/shared/prototype-review-local-api';
import {
  developmentPrototypeTarget,
  embeddedPrototypeUrl,
  feedbackMatchesTarget,
  isIsolatedPrototypeTarget,
  isSafePrototypeTarget,
  parsePrototypeReviewRoute,
  prototypeFrameSandbox,
  rendersPreviewBuildInline,
  prototypeConnectionKind,
  prototypeReviewCodexContext,
  prototypeReviewDevelopmentContext,
  verifiedPreviewBuildPrototypeTarget,
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

const localContext: PrototypeReviewLocalContext = {
  checkedAt: '2026-07-28T10:00:00.000Z',
  checkout: {
    headSha: 'b'.repeat(40),
    repositoryFullName: 'DotNaos/project-space',
    state: 'available'
  },
  codex: {
    machineId: 'os-mac',
    machineName: 'MacBook',
    state: 'available',
    threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
  }
};

describe('prototype review model', () => {
  test('parses a bounded review route', () => {
    expect(parsePrototypeReviewRoute(
      '/prototype-review',
      `?repository=DotNaos%2Fproject-space&pr=356&head=${'a'.repeat(40)}&change=mobile-workflow&surface=native&viewport=tablet&orientation=landscape&theme=light`
    )).toMatchObject({
      changeId: 'mobile-workflow',
      headSha: 'a'.repeat(40),
      matches: true,
      orientation: 'landscape',
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space',
      scenario: undefined,
      surface: 'native',
      theme: 'light',
      viewport: 'tablet'
    });
  });

  test('does not translate missing or unknown scenario parameters into fixture content', () => {
    expect(
      parsePrototypeReviewRoute(
        '/prototype-review',
        '?scenario=unknown'
      ).scenario
    ).toBeUndefined();
    expect(
      parsePrototypeReviewRoute('/prototype-review', '').scenario
    ).toBeUndefined();
  });

  test('prefers an exact live surface over the deployed surface', () => {
    const target = verifiedPrototypeTarget(result, 'web');
    expect(target).toEqual({
      source: 'live',
      surfaceKind: 'desktop-prototype',
      url: 'https://os-mac.example.ts.net/prototype/desktop/'
    });
    expect(feedbackMatchesTarget(result, target)).toBe(true);
    expect(prototypeReviewDevelopmentContext(result, target)).toMatchObject({
      connectionKind: 'tailscale',
      connectorId: 'connector-os-mac',
      machineId: 'os-mac',
      source: 'verified-live',
      threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
    });
  });

  test('uses the exact local App Server task for a local development target', () => {
    const target = developmentPrototypeTarget(
      'http://prototype.localhost:1355/prototype/desktop/',
      'http://review.localhost:1355/prototype-review',
      'web'
    );
    expect(prototypeReviewDevelopmentContext(undefined, target, localContext)).toEqual({
      connectionKind: 'local',
      machineId: 'os-mac',
      source: 'local-runtime',
      threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
    });
  });

  test('never grants local Codex access to a deployed surface', () => {
    const deployed = {
      source: 'deployed' as const,
      surfaceKind: 'desktop-prototype' as const,
      url: 'https://pr-356.projects-os-home.net/prototype/desktop/'
    };
    expect(prototypeReviewDevelopmentContext(undefined, deployed, localContext)).toBeUndefined();
  });

  test('keeps a deployed review shell read-only even with a verified live target', () => {
    const target = verifiedPrototypeTarget(result, 'web');
    expect(target?.source).toBe('live');
    expect(prototypeReviewCodexContext(false, result, target, localContext)).toBeUndefined();
  });

  test('uses deployed native without exposing feedback', () => {
    const target = verifiedPrototypeTarget(result, 'native');
    expect(target?.source).toBe('deployed');
    expect(target?.surfaceKind).toBe('mobile-prototype');
    expect(feedbackMatchesTarget(result, target)).toBe(false);
    expect(prototypeReviewDevelopmentContext(result, target)).toBeUndefined();
  });

  test('requires the selected live URL to match the verified lease exactly', () => {
    const target = {
      source: 'live' as const,
      surfaceKind: 'desktop-prototype' as const,
      url: 'https://other-machine.example.ts.net/prototype/desktop/'
    };
    expect(feedbackMatchesTarget(result, target)).toBe(false);
    expect(prototypeReviewDevelopmentContext(result, target)).toBeUndefined();
  });

  test('classifies local, Tailscale, and other private development routes', () => {
    expect(prototypeConnectionKind('http://prototype.localhost:1355')).toBe('local');
    expect(prototypeConnectionKind('https://os-mac.example.ts.net')).toBe('tailscale');
    expect(prototypeConnectionKind('http://100.100.10.20:4173')).toBe('tailscale');
    expect(prototypeConnectionKind('https://dev.internal.example')).toBe('private');
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
    expect(developmentPrototypeTarget(
      'https://os-mac.example.ts.net/prototype/desktop/',
      'https://review.os-mac.example.ts.net/prototype-review',
      'web'
    )?.url).toBe('https://os-mac.example.ts.net/prototype/desktop/');
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

  test('uses only exact build identity for the same-origin static PR prototype', () => {
    const identity = {
      headSha: 'a'.repeat(40),
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space'
    };
    const target = verifiedPreviewBuildPrototypeTarget({
      currentHref: 'https://pr-356.projects.os-home.net/prototype-review',
      expectedIdentity: identity,
      previewBuildIdentity: identity,
      surface: 'web'
    });
    expect(target).toEqual({
      source: 'preview-build',
      surfaceKind: 'desktop-prototype',
      url: 'https://pr-356.projects.os-home.net/prototype/desktop/'
    });
    expect(isSafePrototypeTarget(
      target,
      'https://pr-356.projects.os-home.net/prototype-review'
    )).toBe(true);
    expect(prototypeFrameSandbox(
      target!,
      'https://pr-356.projects.os-home.net/prototype-review'
    )).toBe('allow-scripts');
    expect(rendersPreviewBuildInline(target, 'branch-head-preview')).toBe(true);
    expect(rendersPreviewBuildInline(target, 'ready')).toBe(false);
    expect(rendersPreviewBuildInline(
      { ...target!, source: 'deployed' },
      'branch-head-preview'
    )).toBe(false);
  });

  test('rejects mismatched build identity and non-Preview hosts', () => {
    const identity = {
      headSha: 'a'.repeat(40),
      pullRequestNumber: 356,
      repositoryFullName: 'DotNaos/project-space'
    };
    expect(verifiedPreviewBuildPrototypeTarget({
      currentHref: 'https://pr-356.projects.os-home.net/prototype-review',
      expectedIdentity: identity,
      previewBuildIdentity: { ...identity, headSha: 'b'.repeat(40) },
      surface: 'web'
    })).toBeUndefined();
    expect(verifiedPreviewBuildPrototypeTarget({
      currentHref: 'https://projects.os-home.net/prototype-review',
      expectedIdentity: identity,
      previewBuildIdentity: identity,
      surface: 'web'
    })).toBeUndefined();
    expect(verifiedPreviewBuildPrototypeTarget({
      currentHref: 'https://pr-356.projects.os-home.net/prototype-review',
      expectedIdentity: identity,
      previewBuildIdentity: identity,
      surface: 'native'
    })).toBeUndefined();
    expect(verifiedPreviewBuildPrototypeTarget({
      currentHref: 'http://pr-356.projects.os-home.net/prototype-review',
      expectedIdentity: identity,
      previewBuildIdentity: identity,
      surface: 'web'
    })).toBeUndefined();
    expect(verifiedPreviewBuildPrototypeTarget({
      currentHref: 'https://pr-356.projects.os-home.net:444/prototype-review',
      expectedIdentity: identity,
      previewBuildIdentity: identity,
      surface: 'web'
    })).toBeUndefined();
    expect(isSafePrototypeTarget(
      {
        source: 'deployed',
        surfaceKind: 'desktop-prototype',
        url: 'https://pr-356.projects.os-home.net/prototype/desktop/'
      },
      'https://pr-356.projects.os-home.net/prototype-review'
    )).toBe(false);
  });
});
