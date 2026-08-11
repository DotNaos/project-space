import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type {
  ConnectorOverviewResult,
  MachineRecord
} from '../src/shared/project-space-api';

function element(tag: ElementType) {
  return ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement(tag, props, children);
}

const HeroChip = Object.assign(element('span'), { Label: element('span') });
const Disclosure = Object.assign(element('section'), {
  Body: element('div'),
  Content: element('div'),
  Heading: element('div'),
  Indicator: element('span'),
  Trigger: element('button')
});

mock.module('@heroui/react', () => ({ Chip: HeroChip, Disclosure }));
mock.module('@wterm/dom', () => ({ WTerm: class {} }));
mock.module('@wterm/dom/css', () => ({}));
mock.module('@/api/project-space-client', () => ({
  isProjectSpaceApiRequestAllowed: () => true,
  refreshProjectSpaceAuthToken: async () => '',
  resolveProjectSpaceApiBaseUrl: () => ''
}));
mock.module('@/app/dotnaos-ui', () => ({
  Button: ({
    children,
    isDisabled,
    isIconOnly: _isIconOnly,
    onPress,
    ...props
  }: {
    children?: ReactNode;
    isDisabled?: boolean;
    isIconOnly?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children),
  Chip: element('span'),
  SearchField: element('div'),
  SearchFieldClearButton: () => null,
  SearchFieldGroup: element('div'),
  SearchFieldInput: element('input'),
  SearchFieldSearchIcon: () => null,
  Surface: element('section'),
  Tab: element('button'),
  TabIndicator: element('span'),
  TabList: element('div'),
  Tabs: ({
    children,
    onSelectionChange: _onSelectionChange,
    selectedKey: _selectedKey,
    ...props
  }: {
    children?: ReactNode;
    onSelectionChange?(key: string): void;
    selectedKey?: string;
    [key: string]: unknown;
  }) => createElement('nav', props, children),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));
mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));
mock.module('../src/features/project-desktop/components/connector-channel-chip', () => ({
  ConnectorChannelChip: () => null
}));
mock.module('../src/features/project-desktop/components/machine-connector-actions-menu', () => ({
  MachineConnectorActionsMenu: () => null
}));
mock.module('../src/features/project-desktop/components/machine-explorer-panel', () => ({
  MachineExplorerPanel: () => null
}));
mock.module('../src/features/project-desktop/components/machine-projects-panel', () => ({
  MachineProjectsPanel: () => null
}));
mock.module('../src/features/project-desktop/components/machine-visuals', () => ({
  isMachineConnected: () => true,
  MachineBatteryMeter: () => null,
  MachineConnectionIcon: () => null,
  MachineDeviceIcon: () => null,
  MachineOsMark: () => null
}));

const { MachineDetailView } = await import(
  '../src/features/project-desktop/components/machine-detail-view'
);

function connector(): MachineRecord {
  return {
    connector: {
      daemon: {
        appServerVersion: '0.78.1',
        authenticated: true,
        backend: 'pid',
        checkedAt: '2026-08-10T12:00:00.000Z',
        cliVersion: '0.78.0',
        compatible: false,
        installed: true,
        managedCodexVersion: '0.78.0',
        paired: false,
        reachable: true,
        remoteControlEnabled: true,
        remoteControlState: 'connecting',
        running: true,
        state: 'incompatible'
      },
      installCommand: 'project connector install',
      runtime: {
        architecture: 'x64',
        buildId: '0'.repeat(40),
        bundleVersions: {
          connector: '1.0.0',
          machineTools: '1.0.0',
          projectCli: '1.0.0'
        },
        channel: 'stable',
        instanceId: 'instance-one',
        lastCheckedAt: '2026-08-10T12:00:00.000Z',
        platform: 'linux',
        protocolVersion: '2',
        releaseId: 'v1.0.0',
        source: 'managed',
        version: '1.0.0'
      },
      status: 'online',
      update: {
        availableReleaseId: 'v2.0.0',
        availableVersion: '2.0.0',
        operation: {
          createdAt: '2026-08-10T12:00:00.000Z',
          id: 'operation-one',
          lastFailure: {
            at: '2026-08-10T12:01:00.000Z',
            code: 'machine-busy',
            message: 'Deferred until the active Codex task becomes idle.',
            rollbackAvailable: false
          },
          machineId: 'connector-raw-uuid',
          operation: 'update',
          requestedByUserId: 'user-one',
          state: 'queued',
          updatedAt: '2026-08-10T12:01:00.000Z'
        },
        state: 'update-pending'
      }
    },
    id: 'connector-raw-uuid',
    kind: 'connector',
    name: 'connector-raw-uuid',
    network: {},
    roles: ['connector'],
    sourcePath: 'test'
  };
}

describe('machine detail view', () => {
  test('shows physical identity and complete connector readiness evidence', () => {
    const machine = connector();
    const overview: ConnectorOverviewResult = {
      machines: [machine],
      machinesRepo: { exists: false, path: '' },
      physicalMachines: [{
        connectorIds: [machine.id],
        id: 'physical-os-pc',
        name: 'os-pc'
      }],
      tailscale: {
        connected: false,
        installed: false,
        ips: [],
        peersOnline: 0,
        serveOrigins: []
      }
    };
    const html = renderToStaticMarkup(
      <MachineDetailView
        connector={overview}
        machine={machine}
        machineId={machine.id}
        onOpenMachines={() => {}}
        onRefreshProjectDiscovery={async () => {}}
        onSelectProject={() => {}}
        onSelectTab={() => {}}
        projects={[]}
        structureViolations={[]}
        tab="overview"
      />
    );

    expect(html).toContain('>os-pc<');
    expect(html).toContain('data-connector-runtime-status="update-pending"');
    expect(html).toContain('Current Project Space');
    expect(html).toContain('Available Project Space');
    expect(html).toContain('v1.0.0');
    expect(html).toContain('v2.0.0');
    expect(html).toContain('Codex CLI');
    expect(html).toContain('v0.78.0');
    expect(html).toContain('Codex app-server');
    expect(html).toContain('v0.78.1');
    expect(html).toContain('Managed Codex');
    expect(html).toContain('Daemon backend');
    expect(html).toContain('>pid<');
    expect(html).toContain('Remote Control');
    expect(html).toContain('connecting');
    expect(html).toContain('Not compatible');
    expect(html).toContain('incompatible');
    expect(html).toContain('Deferred until the active Codex task becomes idle.');
  });
});
