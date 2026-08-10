import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  MachineRecord,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isDisabled, onPress, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children)
}));

const exactWorktreeError = 'The selected development-server worktree is not available on this machine.';

mock.module('../src/features/project-desktop/hooks/use-worktree-dev-servers', () => ({
  useWorktreeDevServers: ({ projectId }: { projectId: string }) => ({
    error: projectId === 'project-wsl' ? exactWorktreeError : '',
    isChecking: false,
    pendingServerKey: '',
    serversForWorktree: new Map(),
    start: () => undefined
  })
}));

const { IssueDevelopmentServers } = await import(
  '../src/features/project-desktop/components/issue-development-servers'
);

function machine({
  environmentKind,
  environmentLabel,
  id,
  name,
  status
}: {
  environmentKind: 'macos' | 'windows' | 'wsl';
  environmentLabel: string;
  id: string;
  name: string;
  status: MachineRecord['connector']['status'];
}): MachineRecord {
  return {
    connector: { installCommand: '', status },
    environment: { kind: environmentKind, label: environmentLabel },
    id,
    kind: 'connector',
    name,
    network: {},
    roles: ['connector'],
    sourcePath: 'test'
  };
}

const wslProject: ProjectSpaceRecord = {
  id: 'project-wsl',
  kind: 'standalone',
  machineId: 'connector-wsl',
  name: 'project-space',
  rootPath: '/home/oli/projects/project-space'
};

describe('issue development servers', () => {
  test('renders every physical machine and every exact connector environment with truthful states', () => {
    const windows = machine({
      environmentKind: 'windows',
      environmentLabel: 'Windows',
      id: 'connector-windows',
      name: 'os-pc',
      status: 'online'
    });
    const wsl = machine({
      environmentKind: 'wsl',
      environmentLabel: 'Ubuntu',
      id: 'connector-wsl',
      name: 'OS-PC-WSL',
      status: 'online'
    });
    const mac = machine({
      environmentKind: 'macos',
      environmentLabel: 'macOS',
      id: 'connector-mac',
      name: 'os-macbook',
      status: 'offline'
    });

    const html = renderToStaticMarkup(
      <IssueDevelopmentServers
        branchName="issue-596"
        localMachineId="connector-mac"
        machineRows={[
          {
            connectorOptions: [
              {
                canRunCommand: true,
                connectorId: windows.id,
                connectorName: windows.name,
                environmentKind: 'windows',
                environmentLabel: 'Windows',
                hasProjectCheckout: false,
                isOnline: true,
                machine: windows
              },
              {
                canRunCommand: true,
                connectorId: wsl.id,
                connectorName: wsl.name,
                environmentKind: 'wsl',
                environmentLabel: 'WSL · Ubuntu',
                hasProjectCheckout: true,
                isOnline: true,
                machine: wsl,
                project: wslProject
              }
            ],
            machineId: windows.id,
            physicalMachineId: 'physical-pc',
            physicalMachineName: 'os-pc'
          },
          {
            connectorOptions: [{
              canRunCommand: false,
              connectorId: mac.id,
              connectorName: mac.name,
              environmentKind: 'macos',
              environmentLabel: 'macOS',
              hasProjectCheckout: true,
              isOnline: false,
              machine: mac,
              project: { ...wslProject, id: 'project-mac', machineId: mac.id }
            }],
            machineId: mac.id,
            physicalMachineId: 'physical-mac',
            physicalMachineName: 'os-macbook'
          },
          {
            connectorOptions: [],
            machineId: 'physical-build',
            physicalMachineId: 'physical-build',
            physicalMachineName: 'build-linux'
          }
        ]}
        projects={[wslProject]}
      />
    );

    expect(html).toContain('os-pc');
    expect(html).toContain('Windows');
    expect(html).toContain('WSL · Ubuntu');
    expect(html).toContain('Project is not registered in this environment.');
    expect(html).toContain(exactWorktreeError);
    expect(html).toContain('os-macbook');
    expect(html).toContain('Connector is offline.');
    expect(html).toContain('build-linux');
    expect(html).toContain('No connector is configured for this machine.');
  });
});
