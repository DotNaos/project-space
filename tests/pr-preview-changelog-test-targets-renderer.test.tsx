import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import * as testTargetsApi from '../src/shared/pr-preview-changelog-test-targets';

mock.module(
  '@/shared/pr-preview-changelog-test-targets',
  () => testTargetsApi
);

const { PullRequestChangelogTestTargets } = await import(
  '../src/features/pr-preview-changelog/pull-request-changelog-test-targets'
);
const { pullRequestChangelogTestTargetsSchema } = testTargetsApi;

const identity = {
  headSha: 'a'.repeat(40),
  pullRequestNumber: 398,
  repositoryFullName: 'DotNaos/project-space'
};

describe('pull request changelog test-target renderer', () => {
  test('renders honest unavailable states without a trusted snapshot', () => {
    const html = renderToStaticMarkup(
      <PullRequestChangelogTestTargets expectedIdentity={identity} />
    );

    expect(html).toContain(
      'No additional test links are available.'
    );
    expect(html).not.toContain('Full Preview');
    expect(html).not.toContain('Mobile prototype');
    expect(html).not.toContain('Desktop prototype');
    expect(html).not.toContain('Live Dev Server');
    expect(html).not.toContain('href=');
  });

  test('renders only a verified deployment URL and never live context', () => {
    const html = renderToStaticMarkup(
      <PullRequestChangelogTestTargets
        expectedIdentity={identity}
        snapshot={{
          identity,
          schema: pullRequestChangelogTestTargetsSchema,
          targets: [
            {
              headSha: identity.headSha,
              kind: 'full-preview',
              state: 'available',
              url: 'https://pr-398.projects.os-home.net/',
              verifiedAt: '2026-07-28T08:00:00Z'
            }
          ]
        }}
      />
    );

    expect(html).toContain('href="https://pr-398.projects.os-home.net/"');
    expect(html).toContain('aria-label="Open Full Preview"');
    expect(html).not.toContain('Live Dev Server');
    expect(html).not.toContain('Mobile prototype');
    expect(html).not.toContain('Desktop prototype');
    expect(html).not.toContain('thread');
    expect(html).not.toContain('feedback');
    expect(html).not.toContain('tailscale');
  });
});
