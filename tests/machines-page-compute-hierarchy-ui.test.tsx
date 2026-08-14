import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectCliComputeInventory } from '../src/shared/compute-inventory-cli-api';

function element(tag: ElementType) {
  return ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement(tag, props, children);
}

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));
mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {
    getTailscaleInventory: async () => ({ devices: [], provider: { refreshState: 'not_checked' }, schemaVersion: 1 }),
    setTailscaleDeviceClassification: async () => ({ classification: 'unclassified', id: 'device', revision: 0 })
  }
}));
mock.module('@/shared/tailscale-inventory-api', () => ({
  tailscaleDeviceClassifications: [
    'unclassified', 'environment', 'deployment_destination', 'console_endpoint', 'ignored'
  ]
}));
mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isIconOnly: _isIconOnly, onPress, ...props }: {
    children?: ReactNode;
    isIconOnly?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, onClick: onPress }, children),
  Chip: element('span'),
  SearchField: element('div'),
  SearchFieldClearButton: () => null,
  SearchFieldGroup: element('div'),
  SearchFieldInput: (props: { [key: string]: unknown }) => createElement('input', props),
  SearchFieldSearchIcon: () => null,
  ListBox: element('div'),
  ListBoxItem: element('div'),
  Select: Object.assign(element('div'), {
    Indicator: element('span'), Popover: element('div'), Trigger: element('button')
  }),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));
mock.module('@heroui/react', () => {
  const Modal = Object.assign(({ children, isOpen }: { children?: ReactNode; isOpen?: boolean }) => (
    isOpen ? createElement('div', undefined, children) : null
  ), {
    Backdrop: element('div'), Body: element('div'), Container: element('div'),
    Dialog: element('div'), Footer: element('div'), Header: element('div'),
    Heading: element('h2'), Icon: element('div'), CloseTrigger: element('button')
  });
  return { Modal };
});
const { MachinesPage } = await import('../src/features/project-desktop/components/machines-page');

const baseProps = {
  inventoryStatus: 'ready' as const,
  localSimulation: true,
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

describe('machines page canonical inventory UI', () => {
  test('renders provider-managed Codespaces directly below GitHub Codespaces', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        environmentInstances: [codespace('project-space-537-qxpr6qvjp9vf5v')],
        platforms: [{ alias: 'github-codespaces', id: 'codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }]
      })
    }));

    expect(html).toContain('GitHub Codespaces');
    expect(html).toContain('project-space-537-qxpr6qvjp9vf5v');
    expect(html).toContain('Provider managed');
    expect(html).not.toContain('Connector');
    expect(html).not.toContain('Host capability record');
  });

  test('renders typed Host capability availability without connector labels', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        hosts: [{
          alias: 'dev-host',
          capabilities: {
            console: [],
            power: [],
            state: 'available' as const,
            summary: {
              console: 'available' as const,
              power: 'available' as const,
              provider: 'jetkvm' as const,
              reset: 'unavailable' as const,
              wakeOnLan: 'unknown' as const
            }
          },
          id: 'host-dev',
          name: 'dev-host',
          platformId: 'local'
        }],
        platforms: [{ alias: 'local', id: 'local', kind: 'local', name: 'Local & self-hosted' }]
      })
    }));

    expect(html).toContain('Power Available');
    expect(html).toContain('Reset Unavailable');
    expect(html).toContain('Wake-on-LAN Unknown');
    expect(html).toContain('JetKVM');
    expect(html).not.toContain('Connector');
  });

  test('renders Workspace Runtime names and keeps unavailable access separate', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        environmentInstances: [{
          ...codespace('workspace-codespace'),
          accessRoutes: [{
            capabilities: [],
            id: 'route-workspace-codespace',
            priority: 1,
            state: 'unavailable' as const,
            type: 'provider_native' as const
          }],
          workspaceInventory: { state: 'available' as const },
          workspaces: [{
            id: 'workspace-runtime-1',
            name: 'Task #717',
            repository: 'DotNaos/project-space',
            runtime: {
              codex: 'unavailable' as const, connection: 'stopped' as const,
              devServers: [], evidence: 'workspace-runtime' as const, lifecycle: 'stopped' as const
            },
            state: 'inactive' as const
          }]
        }],
        platforms: [{ alias: 'github-codespaces', id: 'codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }]
      })
    }));

    expect(html).toContain('Workspace Runtime · Task #717 · DotNaos/project-space');
    expect(html).toContain('Access unavailable');
    expect(html).toContain('Provider managed');
  });

  test('covers present, missing, stale, and stopped Runtime presentation context', () => {
    const renderRuntime = (input: {
      connection: 'online' | 'stale' | 'stopped';
      lifecycle: 'running' | 'stopped';
      name: string;
      repository?: string;
    }) => renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        environmentInstances: [{
          ...codespace(`runtime-${input.connection}`),
          workspaceInventory: { state: 'available' as const },
          workspaces: [{
            id: `workspace-${input.connection}`,
            name: input.name,
            ...(input.repository ? { repository: input.repository } : {}),
            runtime: {
              codex: 'unavailable' as const,
              connection: input.connection,
              devServers: [],
              evidence: 'workspace-runtime' as const,
              lifecycle: input.lifecycle
            },
            state: input.lifecycle === 'stopped' ? 'inactive' as const : 'active' as const
          }]
        }],
        platforms: [{ alias: 'github-codespaces', id: 'codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }]
      })
    }));

    expect(renderRuntime({
      connection: 'online', lifecycle: 'running', name: 'Task #717', repository: 'DotNaos/project-space'
    })).toContain('Workspace Runtime · Task #717 · DotNaos/project-space');
    expect(renderRuntime({
      connection: 'online', lifecycle: 'running', name: 'Workspace Runtime 1'
    })).toContain('Workspace Runtime · Workspace Runtime 1');
    expect(renderRuntime({
      connection: 'online', lifecycle: 'running', name: 'DotNaos/project-space', repository: 'DotNaos/project-space'
    })).not.toContain('Workspace Runtime · DotNaos/project-space · DotNaos/project-space');
    expect(renderRuntime({
      connection: 'stale', lifecycle: 'running', name: 'Task #717', repository: 'DotNaos/project-space'
    })).toContain('Workspace Runtime · Task #717 · DotNaos/project-space');
    expect(renderRuntime({
      connection: 'stopped', lifecycle: 'stopped', name: 'Task #717', repository: 'DotNaos/project-space'
    })).toContain('Workspace Runtime · Task #717 · DotNaos/project-space');
  });

  test('shows empty and unavailable states without falling back to legacy rows', () => {
    const empty = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({ platforms: [{ alias: 'local', id: 'local', kind: 'local', name: 'Local & self-hosted' }] })
    }));
    const unavailable = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      inventoryStatus: 'error' as const,
      loadError: 'We could not refresh the compute inventory.'
    }));

    expect(empty).toContain('No compute environments are configured yet.');
    expect(unavailable).toContain('We could not refresh the compute inventory.');
    expect(unavailable).not.toContain('Canonical compute inventory is unavailable');
  });

  test('shows stale data as stale while keeping the last known environments visible', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        checkedAt: '2026-08-13T10:00:00.000Z',
        environmentInstances: [codespace('stale-codespace')],
        platforms: [{ alias: 'github-codespaces', id: 'codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }]
      }),
      inventoryStatus: 'error' as const,
      loadError: 'We could not refresh the compute inventory.'
    }));

    expect(html).toContain('This inventory may be out of date.');
    expect(html).toContain('Showing the last known inventory.');
    expect(html).toContain('stale-codespace');
  });

  test('labels dual-boot and nested environments in a mixed inventory', () => {
    const local = (alias: string, id: string, parentEnvironmentInstanceId?: string) => ({
      accessRoutes: [],
      alias,
      environmentDefinitionId: 'definition-linux',
      hostId: 'host-a',
      hostResolution: 'manual' as const,
      hostd: { state: 'unknown' as const },
      id,
      kind: 'native_linux' as const,
      name: alias,
      parentEnvironmentInstanceId,
      platformId: 'local',
      providerLifecycleState: 'unknown' as const,
      reference: id,
      resourceMode: 'exclusive' as const,
      workspaceInventory: { state: 'unavailable' as const },
      workspaces: []
    });
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: inventory({
        environmentInstances: [local('windows-01', 'windows'), local('wsl-ubuntu-01', 'wsl', 'windows'), local('ubuntu-01', 'ubuntu')],
        hosts: [{ alias: 'host-a', capabilities: { console: [], power: [], state: 'available' }, id: 'host-a', name: 'host-a', platformId: 'local' }],
        platforms: [{ alias: 'local', id: 'local', kind: 'local', name: 'Local & self-hosted' }]
      })
    }));

    expect(html).toContain('Dual-boot alternative');
    expect(html).toContain('Nested');
    expect(html).toContain('Host reachable');
  });
});
