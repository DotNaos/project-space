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

const computeEnvironmentApi = await import('../src/shared/compute-environment-api');

mock.module('@heroui/react', () => ({ Disclosure }));
mock.module('@/shared/compute-environment-api', () => computeEnvironmentApi);
mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isIconOnly: _isIconOnly, onPress, ...props }: {
    children?: ReactNode;
    isIconOnly?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, onClick: onPress }, children),
  Chip: element('span'),
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

const { SettingsMachineGroups } = await import(
  '../src/features/project-desktop/components/settings-machine-groups'
);

describe('settings compute hierarchy', () => {
  test('renders provider environments directly below their platform with resources', () => {
    const html = renderToStaticMarkup(createElement(SettingsMachineGroups, {
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
        connector: { installCommand: 'project connector install', status: 'online' },
        id: 'codespace-one',
        kind: 'connector',
        name: 'codespace-one',
        network: {},
        roles: ['connector'],
        sourcePath: 'test'
      }],
      credentials: [],
      loadError: '',
      onRefresh: async () => undefined,
      onSaveMachine: async () => undefined,
      physicalMachines: [],
      status: 'ready'
    }));

    expect(html).toContain('GitHub Codespaces');
    expect(html).toContain('Provider managed');
    expect(html).toContain('4 CPU · 8.0 GB · 32 GB');
    expect(html).not.toContain('Ungrouped connector installations');
  });
});
