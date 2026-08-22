import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/shared/tailscale-inventory-api', () => ({
  tailscaleDeviceClassifications: [
    'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
  ]
}));

const { InlineTailscaleClassification } = await import(
  '../src/features/project-desktop/components/tailscale-device-classification'
);

describe('inline Tailnet classification', () => {
  test('uses the DotNaos Select without a permanent Save action', () => {
    const html = renderToStaticMarkup(createElement(InlineTailscaleClassification, {
      device: {
        addresses: ['100.80.135.9'],
        classification: 'environment',
        id: 'os-macbook',
        name: 'os-macbook.tail5bb1d7.ts.net',
        network: {
          checkedAt: '2026-08-21T08:00:00.000Z',
          freshUntil: '2026-08-21T08:01:00.000Z',
          state: 'online'
        },
        revision: 1,
        tags: []
      },
      disabled: false,
      onClassify: async () => undefined
    }));

    expect(html).toContain('Classification for os-macbook.tail5bb1d7.ts.net');
    expect(html).toContain('Environment');
    expect(html).not.toContain('Save');
  });

  test('presents the safe default as Tailnet only instead of internal classification jargon', () => {
    const html = renderToStaticMarkup(createElement(InlineTailscaleClassification, {
      device: {
        addresses: ['100.64.0.1'],
        classification: 'unclassified',
        id: 'tailnet-only',
        name: 'tailnet-only',
        network: {
          checkedAt: '2026-08-21T08:00:00.000Z',
          freshUntil: '2026-08-21T08:01:00.000Z',
          state: 'online'
        },
        os: 'linux',
        revision: 0,
        tags: []
      },
      disabled: false,
      onClassify: async () => undefined
    }));

    expect(html).toContain('Tailnet only');
    expect(html).not.toContain('Unclassified');
  });
});
