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
  Select: Object.assign(({ isDisabled: _isDisabled, ...props }: { isDisabled?: boolean; [key: string]: unknown }) => createElement('div', props), {
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

let currentSourceFixture = sourceFixture;

mock.module('../src/features/project-desktop/hooks/use-compute-sources', () => ({
  useComputeSources: () => currentSourceFixture
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

  test('omits unavailable optional device metadata instead of inventing placeholders', () => {
    currentSourceFixture = {
      ...sourceFixture,
      tailscale: {
        ...sourceFixture.tailscale,
        result: {
          ...sourceFixture.tailscale.result!,
          devices: [{ ...sourceFixture.tailscale.result!.devices[0]!, addresses: [], os: undefined, tags: [] }]
        }
      }
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).not.toContain('No direct Tailscale IP reported');
    expect(html).not.toContain('No operating system or tags reported');
    currentSourceFixture = sourceFixture;
  });

  test('renders independent loading states without empty-state lies', () => {
    currentSourceFixture = {
      ...sourceFixture,
      github: { ...sourceFixture.github, result: undefined, status: 'loading' },
      tailscale: { ...sourceFixture.tailscale, result: undefined, status: 'loading' }
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('Loading Tailscale devices');
    expect(html).toContain('Loading GitHub Codespaces');
    expect(html).not.toContain('No Tailscale devices were reported');
    expect(html).not.toContain('No GitHub Codespaces were reported');
    currentSourceFixture = sourceFixture;
  });

  test('keeps stale devices visible after a provider refresh failure', () => {
    currentSourceFixture = {
      ...sourceFixture,
      tailscale: {
        ...sourceFixture.tailscale,
        error: 'Tailscale inventory could not be refreshed.',
        result: {
          ...sourceFixture.tailscale.result!,
          devices: [{ ...sourceFixture.tailscale.result!.devices[0]!, network: {
            ...sourceFixture.tailscale.result!.devices[0]!.network,
            state: 'unknown' as const
          }}],
          provider: { ...sourceFixture.tailscale.result!.provider, refreshState: 'unavailable' as const }
        },
        status: 'error'
      }
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('Showing the last observed devices');
    expect(html).toContain('os-pc');
    expect(html).toContain('Classification is unavailable while the provider is unavailable');
    expect(html).not.toContain('No Tailscale devices were reported');
    currentSourceFixture = sourceFixture;
  });

  test('describes partial and provider-unavailable empty states precisely', () => {
    currentSourceFixture = {
      ...sourceFixture,
      tailscale: {
        ...sourceFixture.tailscale,
        result: {
          ...sourceFixture.tailscale.result!,
          devices: [],
          provider: { ...sourceFixture.tailscale.result!.provider, refreshState: 'unavailable' as const }
        }
      }
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('No cached Tailscale devices are available');
    expect(html).not.toContain('No Tailscale devices were reported');
    currentSourceFixture = sourceFixture;
  });

  test('marks partial inventories as partial rather than current', () => {
    currentSourceFixture = {
      ...sourceFixture,
      tailscale: {
        ...sourceFixture.tailscale,
        result: {
          ...sourceFixture.tailscale.result!,
          provider: { ...sourceFixture.tailscale.result!.provider, refreshState: 'partial' as const }
        }
      }
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('>Partial</span>');
    expect(html).toContain('partial inventory');
    currentSourceFixture = sourceFixture;
  });

  test('keeps source health honest when either provider is disconnected', () => {
    currentSourceFixture = {
      ...sourceFixture,
      github: {
        ...sourceFixture.github,
        result: {
          ...sourceFixture.github.result!,
          codespaces: [],
          provider: { connectionState: 'not_connected' as const, source: 'github_api' as const }
        }
      },
      tailscale: {
        ...sourceFixture.tailscale,
        result: {
          ...sourceFixture.tailscale.result!,
          devices: [],
          provider: { ...sourceFixture.tailscale.result!.provider, refreshState: 'partial' as const }
        }
      }
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('Connection required');
    expect(html).not.toContain('Both sources are current');
    currentSourceFixture = sourceFixture;
  });

  test('keeps every Tailscale connection failure explicit', () => {
    for (const [connectionState, expected] of [
      ['not_configured', 'Tailscale is not configured'],
      ['configuration_error', 'Tailscale configuration is invalid'],
      ['authentication_error', 'Tailscale authorization failed'],
      ['scope_insufficient', 'devices:core:read'],
      ['unavailable', 'No cached Tailscale devices are available']
    ] as const) {
      currentSourceFixture = {
        ...sourceFixture,
        tailscale: {
          ...sourceFixture.tailscale,
          result: {
            ...sourceFixture.tailscale.result!,
            devices: [],
            provider: { ...sourceFixture.tailscale.result!.provider, connectionState }
          }
        }
      };
      const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));
      expect(html).toContain(expected);
    }
    currentSourceFixture = sourceFixture;
  });

  test('renders provider auth and scope lifecycle states without generic inventory copy', () => {
    currentSourceFixture = {
      ...sourceFixture,
      github: {
        ...sourceFixture.github,
        result: {
          ...sourceFixture.github.result!,
          codespaces: [],
          provider: { connectionState: 'scope_insufficient' as const, source: 'github_api' as const }
        }
      }
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, baseProps));

    expect(html).toContain('Reconnect GitHub once to grant Codespaces access');
    expect(html).not.toContain('No GitHub Codespaces were reported');
    currentSourceFixture = sourceFixture;
  });
});
