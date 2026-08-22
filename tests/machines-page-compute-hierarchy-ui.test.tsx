import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectCliComputeInventory } from '../src/shared/compute-inventory-cli-api';
import type { TailscaleInventoryDevice } from '../src/shared/tailscale-inventory-api';

let tailnetDevices: TailscaleInventoryDevice[] = [];
let tailnetStatus: 'ready' | 'loading' | 'error' = 'ready';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));
mock.module('@/shared/tailscale-inventory-api', () => ({
  tailscaleDeviceClassifications: [
    'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
  ]
}));
mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {
    getLegacyConnectorCleanup: async () => ({ records: [] }),
    removeLegacyConnectors: async () => ({ results: [] })
  }
}));

mock.module('../src/features/project-desktop/hooks/use-tailnet-compute-inventory', () => ({
  useTailnetComputeInventory: () => ({
    assignHost: async () => undefined,
    error: tailnetStatus === 'error' ? 'Tailnet is unavailable.' : '',
    refresh: async () => undefined,
    result: tailnetStatus === 'loading' ? undefined : {
      devices: tailnetDevices,
      provider: {
        connectionState: 'connected',
        refreshState: 'available',
        source: 'tailscale_oauth_api'
      },
      schemaVersion: 1
    },
    status: tailnetStatus
  })
}));

const { MachinesPage } = await import('../src/features/project-desktop/components/machines-page');

const baseProps = {
  inventoryStatus: 'ready' as const,
  localSimulation: false,
  loadError: '',
  onRefresh: async () => undefined
};

function inventory(overrides: Partial<ProjectCliComputeInventory> = {}): ProjectCliComputeInventory {
  return {
    checkedAt: new Date().toISOString(),
    environmentCatalog: [],
    environmentInstances: [],
    hosts: [],
    inventoryState: 'ready',
    platforms: [],
    privateNetworks: [],
    schemaVersion: 3,
    violations: [],
    ...overrides
  };
}

function device(overrides: Partial<TailscaleInventoryDevice> = {}): TailscaleInventoryDevice {
  return {
    addresses: ['100.80.135.9'],
    classification: 'unclassified',
    hostAssignmentRevision: 0,
    id: 'device-macbook',
    name: 'os-macbook.tail5bb1d7.ts.net',
    network: {
      checkedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 60_000).toISOString(),
      state: 'online'
    },
    os: 'macOS',
    revision: 0,
    tags: [],
    ...overrides
  };
}

function codespace(name: string, id = name) {
  return {
    accessRoutes: [],
    alias: name,
    environmentDefinitionId: 'definition-codespace',
    hostResolution: 'not_applicable' as const,
    hostd: { state: 'unknown' as const },
    id,
    kind: 'github_codespace' as const,
    name: 'GitHub Codespace',
    platformId: 'codespaces',
    providerLifecycleState: 'unknown' as const,
    reference: `provider/${id}`,
    resourceMode: 'dedicated' as const,
    resources: {
      architecture: 'x64',
      cpuCores: 4,
      memoryTotalBytes: 8 * 1_024 ** 3,
      operatingSystem: 'linux',
      reportedAt: new Date().toISOString(),
      source: 'provider' as const,
      storageTotalBytes: 32 * 1_024 ** 3
    },
    workspaceInventory: { state: 'unavailable' as const },
    workspaces: []
  };
}

describe('machines page Tailnet device to Host hierarchy', () => {
  test('renders Codespaces separately without fabricating Hosts', () => {
    tailnetDevices = [];
    tailnetStatus = 'ready';
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        environmentInstances: [codespace('project-space-537-qxpr6qvjp9vf5v')],
        platforms: [{ alias: 'github-codespaces', id: 'codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }]
      })
    }));

    expect(html).toContain('GitHub Codespaces');
    expect(html).toContain('project-space-537-qxpr6qvjp9vf5v');
    expect(html).toContain('0 Hosts');
    expect(html).not.toContain('Provider managed');
    expect(html).not.toContain('data-ui-component="Card"');
  });

  test('groups only manually assigned Tailnet devices under a Host', () => {
    tailnetDevices = [
      device({ hostAssignmentRevision: 2, hostId: 'host-macbook' }),
      device({ hostAssignmentRevision: 2, hostId: 'host-macbook', id: 'device-macbook-vm', name: 'os-macbook-vm' })
    ];
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        environmentInstances: [{
          ...codespace('legacy-environment'),
          hostId: 'host-macbook',
          hostResolution: 'manual' as const,
          kind: 'native_linux' as const,
          platformId: 'local'
        }],
        hosts: [{
          alias: 'os-macbook', capabilities: { console: [], power: [], state: 'unknown' as const },
          id: 'host-macbook', name: 'os-macbook', platformId: 'local'
        }]
      })
    }));

    expect(html).toContain('Hosts');
    expect(html).toContain('os-macbook');
    expect(html).not.toContain('2/2 online');
    expect(html).toContain('data-section-summary="true">2</span>');
    expect(html).toContain('Move');
    expect(html).not.toContain('legacy-environment');
    expect(html).not.toContain('Environment');
    expect(html).not.toContain('Unclassified');
    expect(html).not.toContain('Type');
  });

  test('shows supported unassigned devices in the available section', () => {
    tailnetDevices = [device()];
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory()
    }));

    expect(html).toContain('Available Tailnet devices');
    expect(html).toContain('os-macbook');
    expect(html).toContain('Assign');
    expect(html).toContain('Online');
    expect(html).toContain('macOS');
  });

  test('keeps unsupported devices in a collapsed excluded section', () => {
    tailnetDevices = [device({ id: 'iphone', name: 'oli-iphone', os: 'iOS' })];
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory()
    }));

    expect(html).toContain('Excluded Tailnet devices');
    expect(html).toContain('data-section-summary="true">1</span>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('oli-iphone');
  });

  test('keeps every section collapsible and avoids legacy controls', () => {
    tailnetDevices = [
      device({ hostAssignmentRevision: 1, hostId: 'host-macbook' }),
      device({ id: 'device-vps', name: 'os-vps-1', os: 'linux' }),
      device({ id: 'iphone', name: 'oli-iphone', os: 'iOS' })
    ];
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        environmentInstances: [codespace('project-space-732')],
        hosts: [{
          alias: 'os-macbook', capabilities: { console: [], power: [], state: 'unknown' },
          id: 'host-macbook', name: 'os-macbook', platformId: 'local'
        }]
      })
    }));

    expect((html.match(/data-ui-component="CollapsibleSection"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).not.toContain('Add environment');
    expect(html).not.toContain('Local &amp; self-hosted');
    expect(html).not.toContain('uppercase');
    expect(html).not.toContain('dialog');
    expect(html).toContain('Assign os-vps-1 to a Host');
    expect(html).not.toContain('Create new Host');
    expect((html.match(/data-separated="true"/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((html.match(/ml-4 sm:ml-6/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((html.match(/<thead class="sr-only">/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test('waits for both inventories before showing an empty state', () => {
    tailnetDevices = [];
    tailnetStatus = 'loading';
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory()
    }));

    expect(html).toContain('Loading inventory…');
    expect(html).not.toContain('No compute resources were reported.');
    tailnetStatus = 'ready';
  });
});
