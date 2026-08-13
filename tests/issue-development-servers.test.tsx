import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  MachineRecord,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';
import type { WorktreeSetupResult } from '../src/shared/worktree-action-api';

mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {
    materializeWorktree: () => Promise.resolve({ state: 'ready' })
  }
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, isDisabled, onPress, ...props }: {
    children?: ReactNode;
    isDisabled?: boolean;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, disabled: isDisabled, onClick: onPress }, children)
}));

const exactWorktreeError = 'The selected development-server worktree is not available on this machine.';
const currentCheckedAt = new Date().toISOString();
const unavailableServer = {
  capability: 'unavailable' as const,
  checkedAt: currentCheckedAt,
  lastError: 'The storybook declaration is not available in this environment.',
  machineId: 'connector-unavailable',
  projectId: 'project-unavailable',
  runTarget: 'storybook',
  serverId: 'storybook',
  serverLabel: 'Component stories',
  state: 'stopped' as const,
  worktreeId: 'worktree-unavailable'
};
const setupServer = {
  capability: 'configured' as const,
  checkedAt: currentCheckedAt,
  machineId: 'connector-setup',
  projectId: 'project-setup',
  runTarget: 'dev',
  serverId: 'dev',
  serverLabel: 'App',
  state: 'stopped' as const,
  worktreeId: 'worktree-setup'
};
const refreshErrorProjectId = 'project-refresh-error';
const refreshErrorMessage = 'The connector stopped responding during development-server refresh.';
const disconnectedProjectId = 'project-disconnected';
const disconnectedConnectorError = 'cc01e88f-b873-4148-a356-86fec62b224a is registered, but its live command channel is not connected yet. Restart or update the Project Space connector on that machine.';
const refreshErrorServers = [
  {
    ...setupServer,
    projectId: refreshErrorProjectId,
    publicPort: 43121,
    serverId: 'dev',
    serverLabel: 'App',
    state: 'running' as const,
    tailscaleIPv4: '100.100.20.5',
    tailscaleUrl: 'http://100.100.20.5:43121/',
    verifiedAt: currentCheckedAt
  },
  {
    ...setupServer,
    projectId: refreshErrorProjectId,
    serverId: 'docs',
    serverLabel: 'Docs',
    state: 'stopped' as const
  }
];
const setupResultsByProject = new Map<string, WorktreeSetupResult>([
  ['project-unavailable', {
    capability: 'unavailable',
    checkedAt: '2026-08-10T12:00:00.000Z',
    machineId: unavailableServer.machineId,
    projectId: unavailableServer.projectId,
    steps: [],
    worktreeId: unavailableServer.worktreeId
  }],
  [refreshErrorProjectId, {
    capability: 'configured',
    checkedAt: currentCheckedAt,
    machineId: setupServer.machineId,
    projectId: refreshErrorProjectId,
    steps: [],
    worktreeId: setupServer.worktreeId
  }]
]);

mock.module('../src/features/project-desktop/hooks/use-worktree-dev-servers', () => ({
  useWorktreeDevServers: ({ projectId }: { projectId: string }) => ({
    error: projectId === 'project-wsl'
      ? exactWorktreeError
      : projectId === disconnectedProjectId
        ? disconnectedConnectorError
      : projectId === refreshErrorProjectId
        ? refreshErrorMessage
        : '',
    isChecking: false,
    pendingServerKey: '',
    refresh: () => Promise.resolve(undefined),
    serversForWorktree: projectId === 'project-unavailable'
      ? new Map([[unavailableServer.worktreeId, [unavailableServer]]])
      : projectId === 'project-setup'
        ? new Map([[setupServer.worktreeId, [setupServer]]])
        : projectId === refreshErrorProjectId
          ? new Map([[setupServer.worktreeId, refreshErrorServers]])
          : new Map(),
    start: () => undefined
  })
}));

mock.module('../src/features/project-desktop/hooks/use-worktree-setup', () => ({
  useWorktreeSetup: ({ projectId }: { projectId: string }) => {
    const result = setupResultsByProject.get(projectId);
    return {
      errors: new Map(),
      isChecking: false,
      pendingKeys: new Set(),
      prepare: () => Promise.resolve(),
      results: result ? new Map([[result.worktreeId, result]]) : new Map()
    };
  }
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

function setupResult(state: 'failed' | 'ready' | 'required'): WorktreeSetupResult {
  return {
    capability: 'configured',
    checkedAt: '2026-08-10T12:00:00.000Z',
    machineId: setupServer.machineId,
    projectId: setupServer.projectId,
    steps: [{
      checkedAt: '2026-08-10T12:00:00.000Z',
      commitSha: 'a'.repeat(40),
      declarationDigest: 'digest-1',
      ...(state === 'failed' ? { lastError: 'Trusted setup did not complete.' } : {}),
      setupStepId: 'install',
      state
    }],
    worktreeId: setupServer.worktreeId
  };
}

function renderSetupServer(canManage = true) {
  const setupMachine = machine({
    environmentKind: 'wsl',
    environmentLabel: 'Ubuntu',
    id: setupServer.machineId,
    name: 'OS-PC-WSL',
    status: 'online'
  });
  const setupProject: ProjectSpaceRecord = {
    ...wslProject,
    id: setupServer.projectId,
    machineId: setupMachine.id
  };
  return renderToStaticMarkup(
    <IssueDevelopmentServers
      branchName="issue-596"
      canManage={canManage}
      localMachineId="connector-local"
      machineRows={[{
        connectorOptions: [{
          canRunCommand: true,
          connectorId: setupMachine.id,
          connectorName: setupMachine.name,
          environmentLabel: 'WSL · Ubuntu',
          hasProjectCheckout: true,
          isOnline: true,
          machine: setupMachine,
          project: setupProject
        }],
        machineId: setupMachine.id,
        physicalMachineId: 'physical-pc',
        physicalMachineName: 'os-pc'
      }]}
      projects={[setupProject]}
    />
  );
}

describe('issue development servers', () => {
  test('renders only online machines and their exact connector environments', () => {
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
    expect(html).toContain('Prepare workspace');
    expect(html).not.toContain('os-macbook');
    expect(html).not.toContain('Connector is offline.');
    expect(html).not.toContain('build-linux');
    expect(html).not.toContain('No connector is configured for this machine.');
  });

  test('does not offer Start for an unavailable declared server', () => {
    const unavailableMachine = machine({
      environmentKind: 'wsl',
      environmentLabel: 'Ubuntu',
      id: 'connector-unavailable',
      name: 'OS-PC-WSL',
      status: 'online'
    });
    const unavailableProject: ProjectSpaceRecord = {
      ...wslProject,
      id: 'project-unavailable',
      machineId: unavailableMachine.id
    };
    const html = renderToStaticMarkup(
      <IssueDevelopmentServers
        branchName="issue-596"
        localMachineId="connector-local"
        machineRows={[{
          connectorOptions: [{
            canRunCommand: true,
            connectorId: unavailableMachine.id,
            connectorName: unavailableMachine.name,
            environmentLabel: 'WSL · Ubuntu',
            hasProjectCheckout: true,
            isOnline: true,
            machine: unavailableMachine,
            project: unavailableProject
          }],
          machineId: unavailableMachine.id,
          physicalMachineId: 'physical-pc',
          physicalMachineName: 'os-pc'
        }]}
        projects={[unavailableProject]}
      />
    );

    expect(html).toContain('Component stories');
    expect(html).toContain('Unavailable');
    expect(html).toContain(unavailableServer.lastError);
    expect(html).toContain('.project/scripts.yaml');
    expect(html).not.toContain('>Start<');
  });

  test('removes retained Start and Open actions after a server refresh failure', () => {
    const refreshErrorMachine = machine({
      environmentKind: 'wsl',
      environmentLabel: 'Ubuntu',
      id: setupServer.machineId,
      name: 'OS-PC-WSL',
      status: 'online'
    });
    const refreshErrorProject: ProjectSpaceRecord = {
      ...wslProject,
      id: refreshErrorProjectId,
      machineId: refreshErrorMachine.id
    };
    const html = renderToStaticMarkup(
      <IssueDevelopmentServers
        branchName="issue-596"
        localMachineId="connector-local"
        machineRows={[{
          connectorOptions: [{
            canRunCommand: true,
            connectorId: refreshErrorMachine.id,
            connectorName: refreshErrorMachine.name,
            environmentLabel: 'WSL · Ubuntu',
            hasProjectCheckout: true,
            isOnline: true,
            machine: refreshErrorMachine,
            project: refreshErrorProject
          }],
          machineId: refreshErrorMachine.id,
          physicalMachineId: 'physical-pc',
          physicalMachineName: 'os-pc'
        }]}
        projects={[refreshErrorProject]}
      />
    );

    expect(html).toContain(refreshErrorMessage);
    expect(html).toContain('Status unavailable');
    expect(html).not.toContain('>Open<');
    expect(html).not.toContain('>Start<');
  });

  test('shows a disconnected connector without leaking its internal id', () => {
    const disconnectedMachine = machine({
      environmentKind: 'macos',
      environmentLabel: 'macOS',
      id: 'connector-disconnected',
      name: 'os-macbook',
      status: 'online'
    });
    const disconnectedProject: ProjectSpaceRecord = {
      ...wslProject,
      id: disconnectedProjectId,
      machineId: disconnectedMachine.id
    };
    const html = renderToStaticMarkup(
      <IssueDevelopmentServers
        branchName="issue-604"
        localMachineId="connector-local"
        machineRows={[{
          connectorOptions: [{
            canRunCommand: true,
            connectorId: disconnectedMachine.id,
            connectorName: disconnectedMachine.name,
            environmentLabel: 'macOS',
            hasProjectCheckout: true,
            isOnline: true,
            machine: disconnectedMachine,
            project: disconnectedProject
          }],
          machineId: disconnectedMachine.id,
          physicalMachineId: 'physical-mac',
          physicalMachineName: 'os-macbook'
        }]}
        projects={[disconnectedProject]}
      />
    );

    expect(html).toContain('Disconnected');
    expect(html).not.toContain('cc01e88f-b873-4148-a356-86fec62b224a');
    expect(html).not.toContain('live command channel');
    expect(html).not.toContain('>Online<');
  });

  test('runs or retries exact trusted setup before offering server start', () => {
    setupResultsByProject.set(setupServer.projectId, setupResult('required'));
    const required = renderSetupServer();
    expect(required).toContain('Setup is required before starting development servers.');
    expect(required).toContain('Run setup');
    expect(required).not.toContain('>Start<');

    setupResultsByProject.set(setupServer.projectId, setupResult('failed'));
    const failed = renderSetupServer();
    expect(failed).toContain('Trusted setup did not complete.');
    expect(failed).toContain('Retry setup');
    expect(failed).not.toContain('>Start<');

    setupResultsByProject.set(setupServer.projectId, setupResult('ready'));
    const ready = renderSetupServer();
    expect(ready).not.toContain('Run setup');
    expect(ready).not.toContain('Retry setup');
    expect(ready).toContain('>Start<');
  });

  test('shows an unavailable setup inspection error and keeps Start blocked', () => {
    setupResultsByProject.set(setupServer.projectId, {
      ...setupResult('ready'),
      capability: 'unavailable',
      lastError: 'Trusted setup is unavailable.',
      steps: []
    });

    const html = renderSetupServer();
    expect(html).toContain('Setup unavailable');
    expect(html).toContain('Trusted setup is unavailable.');
    expect(html).not.toContain('>Start<');
  });

  test('keeps historical task views read-only when setup is required', () => {
    setupResultsByProject.set(setupServer.projectId, setupResult('required'));
    const html = renderSetupServer(false);

    expect(html).toContain('Setup is required before starting development servers.');
    expect(html).not.toContain('Run setup');
    expect(html).not.toContain('Retry setup');
    expect(html).not.toContain('>Start<');
  });

  test('shows the declaration as the next step when no server exists', () => {
    const emptyMachine = machine({
      environmentKind: 'wsl',
      environmentLabel: 'Ubuntu',
      id: 'connector-empty',
      name: 'OS-PC-WSL',
      status: 'online'
    });
    const emptyProject: ProjectSpaceRecord = {
      ...wslProject,
      id: 'project-empty',
      machineId: emptyMachine.id
    };
    const html = renderToStaticMarkup(
      <IssueDevelopmentServers
        branchName="issue-596"
        localMachineId="connector-local"
        machineRows={[{
          connectorOptions: [{
            canRunCommand: true,
            connectorId: emptyMachine.id,
            connectorName: emptyMachine.name,
            environmentLabel: 'WSL · Ubuntu',
            hasProjectCheckout: true,
            isOnline: true,
            machine: emptyMachine,
            project: emptyProject
          }],
          machineId: emptyMachine.id,
          physicalMachineId: 'physical-empty',
          physicalMachineName: 'os-pc'
        }]}
        projects={[emptyProject]}
      />
    );

    expect(html).toContain('No development servers are declared for this worktree.');
    expect(html).toContain('.project/scripts.yaml');
    expect(html).not.toContain('>Start<');
  });
});
