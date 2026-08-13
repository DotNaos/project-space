import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeAccessLink } from '../src/features/project-desktop/components/runtime-access-link';

describe('runtime access link', () => {
  test('shows the verified Tailscale address for a published local runtime', () => {
    const markup = renderToStaticMarkup(<RuntimeAccessLink runtime={{
      accessUrl: 'http://100.64.0.8:44419',
      apis: 'simulated',
      data: 'local',
      network: 'external',
      secrets: 'none'
    }} />);

    expect(markup).toContain('100.64.0.8:44419');
    expect(markup).toContain('href="http://100.64.0.8:44419"');
    expect(markup).toContain('data-testid="tailscale-logo"');
    expect(markup).toContain('text-blue-400');
    expect(markup).not.toContain('external-link');
  });

  test('does not call a loopback runtime Tailscale', () => {
    const markup = renderToStaticMarkup(<RuntimeAccessLink runtime={{
      accessUrl: 'http://project.localhost:1355',
      apis: 'simulated',
      data: 'local',
      network: 'loopback-only',
      secrets: 'none'
    }} />);

    expect(markup).toContain('This Mac');
    expect(markup).not.toContain('Tailscale');
  });
});
