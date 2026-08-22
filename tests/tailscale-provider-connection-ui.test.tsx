import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TailscaleInventoryResult } from '../src/shared/tailscale-inventory-api';

function element(tag: ElementType) {
  return ({ children, text, ...props }: {
    children?: ReactNode;
    text?: string;
    [key: string]: unknown;
  }) => createElement(tag, props, children ?? text);
}

mock.module('@dotnaos/ui/base', () => ({
  Container: Object.assign(element('div'), { Stack: element('div') }),
  Select: element('select'),
  Spinner: element('span'),
  Text: element('span')
}));
mock.module('@/shared/tailscale-inventory-api', () => ({
  tailscaleDeviceClassifications: [
    'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
  ]
}));

const {
  TailnetProviderStatus,
  tailnetProviderStatusCopy
} = await import('../src/features/project-desktop/components/tailscale-device-classification');

type Provider = TailscaleInventoryResult['provider'];

function provider(overrides: Partial<Provider>): Provider {
  return {
    connectionState: 'connected',
    refreshState: 'available',
    source: 'tailscale_oauth_api',
    ...overrides
  };
}

function render(value: Provider) {
  return renderToStaticMarkup(createElement(TailnetProviderStatus, { provider: value }));
}

describe('Tailscale provider state in the primary inventory', () => {
  test('shows deployment-owned configuration without credential or lifecycle controls', () => {
    const html = render(provider({ connectionState: 'configured' }));

    expect(html).toContain('Tailscale is configured for this deployment');
    expect(html).toContain('Refresh devices to verify the deployment credential and load current Tailnet evidence.');
    expect(html).not.toMatch(/Client ID|Client secret|Connect Tailscale API|Disconnect|input|form/);
  });

  test('labels the temporary source without presenting it as an account connection', () => {
    const html = render(provider({
      connectionState: 'legacy',
      source: 'temporary_vps_local_status'
    }));

    expect(html).toContain('Temporary VPS local Tailscale');
    expect(html).toContain('temporary server-local source remains active');
    expect(html).not.toMatch(/Client ID|Client secret|Connect Tailscale API|Disconnect/);
  });

  test('sanitizes every deployment credential failure state', () => {
    for (const connectionState of [
      'configuration_error', 'authentication_error', 'scope_insufficient', 'unavailable'
    ] as const) {
      const html = render(provider({ connectionState }));
      expect(html).toMatch(/Tailscale credential could not be used|Tailscale is temporarily unavailable|devices:core:read/);
      expect(html).not.toMatch(/Client ID|Client secret|Connect Tailscale API|Disconnect|token=|secret=/i);
    }
  });

  test('keeps the healthy provider implicit and never recreates the device modal', () => {
    expect(tailnetProviderStatusCopy(provider({ connectionState: 'connected' }))).toBeUndefined();
    expect(render(provider({ connectionState: 'connected' }))).toBe('');
    expect(render(provider({ connectionState: 'configured' }))).not.toMatch(/modal|dialog|Tailnet devices/i);
  });
});
