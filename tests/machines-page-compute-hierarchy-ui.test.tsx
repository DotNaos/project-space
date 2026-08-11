import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

function element(tag: ElementType) {
  return ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement(tag, props, children);
}

const Disclosure = Object.assign(({
  children,
  defaultExpanded: _defaultExpanded,
  ...props
}: { children?: ReactNode; defaultExpanded?: boolean; [key: string]: unknown }) => (
  createElement('section', props, children)
), {
  Body: element('div'),
  Content: element('div'),
  Heading: element('div'),
  Indicator: element('span'),
  Trigger: element('button')
});
const HeroChip = Object.assign(element('span'), { Label: element('span') });

const computeEnvironmentApi = await import('../src/shared/compute-environment-api');

mock.module('@heroui/react', () => ({ Chip: HeroChip, Disclosure }));
mock.module('@/shared/compute-environment-api', () => computeEnvironmentApi);
mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
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
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));
mock.module('../src/features/project-desktop/components/connector-channel-chip', () => ({
  ConnectorChannelChip: () => createElement('span', null, 'Stable')
}));
mock.module('../src/features/project-desktop/components/machine-connector-actions-menu', () => ({
  MachineConnectorActionsMenu: () => null
}));
mock.module('../src/features/project-desktop/components/machine-visuals', () => ({
  MachineConnectionIcon: () => null,
  MachineDeviceIcon: () => null,
  MachineOsMark: () => null
}));
mock.module('../src/features/project-desktop/components/settings-machine-runtime-stop', () => ({
  SettingsMachineRuntimeStop: () => null
}));
mock.module('../src/features/project-desktop/components/settings-connector-machine-editor', () => ({
  SettingsConnectorMachineEditor: () => null
}));

const { MachinesPage } = await import(
  '../src/features/project-desktop/components/machines-page'
);

const baseProps = {
  credentialListError: '',
  credentials: [],
  hasCopiedInstallCommand: false,
  installCommand: '',
  installScriptHref: '',
  installerError: '',
  isGeneratingInstaller: false,
  loadError: '',
  onCopyInstallCommand: () => undefined,
  onGenerateInstallCommand: () => undefined,
  onRefresh: async () => undefined,
  onRefreshCredentials: () => undefined,
  onRevokeCredential: () => undefined,
  onSaveMachine: async () => undefined,
  physicalMachines: [],
  revokingCredentialId: '',
  status: 'ready' as const,
  tailscale: {
    connected: false,
    installed: false,
    ips: [],
    peersOnline: 0,
    serveOrigins: []
  }
};

describe('machines page compute hierarchy', () => {
  test('renders provider environments directly below their platform with resources', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      computeInventory: {
        connectors: [{
          associatedAt: '2026-08-08T00:00:00.000Z',
          connectorId: 'codespace-one',
          environmentId: 'environment-one'
        }],
        environments: [{
          hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
          id: 'environment-one',
          identity: { key: 'environment:codespace01234567', version: 1 },
          kind: 'github_codespace',
          name: 'GitHub Codespace',
          platformId: 'platform-codespaces',
          resourceMode: 'dedicated',
          resources: {
            architecture: 'amd64',
            cpu: { cores: 4 },
            memory: { totalBytes: 8 * 1_024 ** 3 },
            operatingSystem: 'linux',
            reportedAt: '2026-08-08T00:00:00.000Z',
            source: 'connector',
            storage: { totalBytes: 32 * 1_024 ** 3 }
          }
        }],
        hosts: [],
        platforms: [{ id: 'platform-codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }],
        violations: []
      },
      connectors: [{
        connector: {
          installCommand: 'project connector install',
          status: 'online',
          update: { state: 'update-pending' }
        },
        id: 'codespace-one',
        kind: 'connector',
        name: 'codespace-one',
        network: {},
        roles: ['connector'],
        sourcePath: 'test'
      }]
    }));

    expect(html).toContain('GitHub Codespaces');
    expect(html).toContain('GitHub Codespace');
    expect(html).toContain('Provider managed');
    expect(html).toContain('4 CPU · 8.0 GB · 32 GB');
    expect(html).toContain('data-connector-runtime-status="update-pending"');
    expect(html).toContain('Update pending');
    expect(html.match(/data-connector-runtime-status="update-pending"/g)).toHaveLength(2);
  });

  test('falls back to the flat machine list without a compute inventory', () => {
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      connectors: [
        {
          connector: {
            installCommand: 'project connector install',
            status: 'online',
            update: { state: 'update-available' }
          },
          id: 'connector-stale',
          kind: 'connector',
          name: 'connector-stale',
          network: {},
          roles: ['connector'],
          sourcePath: 'test'
        },
        {
          connector: {
            installCommand: 'project connector install',
            status: 'online',
            update: { state: 'updating' }
          },
          id: 'connector-updating',
          kind: 'connector',
          name: 'connector-updating',
          network: {},
          roles: ['connector'],
          sourcePath: 'test'
        },
        {
          connector: {
            installCommand: 'project connector install',
            status: 'offline',
            update: { state: 'update-available' }
          },
          id: 'connector-archived-stale',
          kind: 'connector',
          name: 'connector-archived-stale',
          network: {},
          roles: ['connector'],
          sourcePath: 'test'
        }
      ],
      credentials: [{
        createdAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-08-01T00:00:00.000Z',
        id: 'credential-archived',
        machineId: 'connector-archived-stale',
        status: 'revoked'
      }],
      physicalMachines: [{
        connectorIds: ['connector-stale', 'connector-updating', 'connector-archived-stale'],
        id: 'physical-os-macbook',
        name: 'os-macbook'
      }]
    }));

    expect(html).toContain('os-macbook');
    expect(html).not.toContain('Provider managed');
    expect(html).toContain('data-connector-runtime-status="update-available"');
    expect(html).toContain('Update available');
    expect(html.match(/data-connector-runtime-status="updating"/g)).toHaveLength(2);
    expect(html).toContain('Updating');
    expect(html).toContain('Archived connector history (1)');
    expect(html).toContain('connector-archived-stale');
    expect(html.match(/data-connector-runtime-status="update-available"/g)).toHaveLength(2);
  });

  test('labels a connector with conflicting physical identities explicitly', () => {
    const connector = {
      connector: { installCommand: 'project connector install', status: 'online' as const },
      id: 'connector-conflict',
      kind: 'connector' as const,
      name: 'connector-conflict',
      network: {},
      roles: ['connector' as const],
      sourcePath: 'test'
    };
    const html = renderToStaticMarkup(createElement(MachinesPage, {
      ...baseProps,
      connectors: [connector],
      physicalMachines: [
        { connectorIds: [connector.id], id: 'physical-a', name: 'A' },
        { connectorIds: [connector.id], id: 'physical-b', name: 'B' }
      ]
    }));

    expect(html).toContain('Identity conflict');
    expect(html).not.toContain('Ungrouped');
  });
});
