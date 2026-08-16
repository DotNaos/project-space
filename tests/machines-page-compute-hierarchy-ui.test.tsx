import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function element(tag: ElementType) {
  return ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement(tag, props, children);
}

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));
mock.module('@/shared/tailscale-inventory-api', () => ({
  tailscaleDeviceClassifications: [
    'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
  ]
}));
mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isDisabled: _isDisabled, isIconOnly: _isIconOnly, onPress, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    isIconOnly?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, onClick: onPress }, children),
  Chip: element('span'),
  ListBox: ({ children, selectedKeys: _selectedKeys, ...props }: {
    children?: ReactNode;
    selectedKeys?: unknown;
    [key: string]: unknown;
  }) => createElement('div', props, children),
  ListBoxItem: ({ children, textValue: _textValue, ...props }: {
    children?: ReactNode;
    textValue?: string;
    [key: string]: unknown;
  }) => createElement('div', props, children),
  SearchField: element('div'),
  SearchFieldClearButton: () => null,
  SearchFieldGroup: element('div'),
  SearchFieldInput: (props: { [key: string]: unknown }) => createElement('input', props),
  SearchFieldSearchIcon: () => null,
  Select: Object.assign(element('div'), {
    Indicator: element('span'), Popover: element('div'), Trigger: element('button')
  }),
  Surface: element('section'),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));

const sourceFixture = {
  classifyTailscaleDevice: async () => undefined,
  github: {
    error: '',
    result: {
      apiVersion: 1 as const,
      checkedAt: '2026-08-16T13:00:00.000Z',
      codespaces: [{
        createdAt: '2026-08-15T12:00:00.000Z',
        displayName: '#732 Compute redesign',
        name: 'probable-space-lamp',
        ref: 'refs/heads/issue-732-redesign-compute-page',
        repositoryFullName: 'DotNaos/project-space',
        state: 'Available',
        url: 'https://github.com/codespaces/probable-space-lamp'
      }],
      provider: { connectionState: 'connected' as const, source: 'github_api' as const }
    },
    status: 'ready' as const
  },
  refreshGitHub: async () => undefined,
  refreshTailscale: async () => undefined,
  tailscale: {
    error: '',
    result: {
      devices: [{
        addresses: ['100.64.0.12', 'fd7a:115c:a1e0::12'],
        classification: 'environment' as const,
        id: 'device-12',
        name: 'os-pc',
        network: {
          checkedAt: '2026-08-16T12:59:00.000Z',
          freshUntil: '2026-08-16T13:00:00.000Z',
          state: 'online' as const
        },
        os: 'linux',
        revision: 3,
        tags: ['tag:workstation']
      }],
      provider: {
        connectionState: 'connected' as const,
        refreshState: 'available' as const,
        source: 'tailscale_oauth_api' as const
      },
      schemaVersion: 1 as const
    },
    status: 'ready' as const
  }
};

mock.module('../src/features/project-desktop/hooks/use-compute-sources', () => ({
  useComputeSources: () => sourceFixture
}));

const { MachinesPage } = await import('../src/features/project-desktop/components/machines-page');

const baseProps = {
  inventoryStatus: 'ready' as const,
  localSimulation: false,
  loadError: '',
  onRefresh: async () => undefined
};

describe('source-first Compute page UI', () => {
  test('renders real provider-shaped Tailscale and GitHub rows once', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('Deployment Tailscale API');
    expect(html).toContain('100.64.0.12');
    expect(html).toContain('fd7a:115c:a1e0::12');
    expect(html).toContain('Environment');
    expect(html).toContain('#732 Compute redesign');
    expect(html).toContain('DotNaos/project-space');
    expect(html).toContain('Available');
    expect(html.match(/>os-pc</g)).toHaveLength(1);
    expect(html.match(/probable-space-lamp/g)).toHaveLength(2);
  });

  test('removes the legacy hierarchy and duplicate inventory controls', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).not.toContain('Tailnet devices');
    expect(html).not.toContain('Legacy Connector');
    expect(html).not.toContain('Connector');
    expect(html).not.toContain('Power Available');
    expect(html).not.toContain('Reset');
    expect(html).not.toContain('Workspace Runtime');
    expect(html).not.toContain('Add environment');
  });

  test('keeps phone rows stacked and introduces desktop columns without page overflow', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('grid min-w-0 gap-4 py-5 lg:grid-cols-');
    expect(html).toContain('sm:grid-cols-');
    expect(html).toContain('break-all');
    expect(html).toContain('overflow-y-auto');
    expect(html).not.toContain('overflow-x-auto overscroll');
  });
});
