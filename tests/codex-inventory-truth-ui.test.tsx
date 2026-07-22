import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ElementType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CodexMachine,
  CodexSession
} from '../src/features/codex-sessions/codex-sessions-types';
import type { MachineRecord } from '../src/shared/project-space-api';

mock.module('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' ')
}));

mock.module('@/app/dotnaos-ui', () => ({
  Button: ({ children, onPress, ...props }: {
    children?: ReactNode;
    onPress?(): void;
    [key: string]: unknown;
  }) => createElement('button', { ...props, onClick: onPress }, children),
  SearchField: ({ children, ...props }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('div', props, children),
  SearchFieldClearButton: () => null,
  SearchFieldGroup: ({ children, ...props }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement('div', props, children),
  SearchFieldInput: (props: Record<string, unknown>) => createElement('input', props),
  Text: ({ as = 'span', children, ...props }: {
    as?: ElementType;
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement(as, props, children)
}));

mock.module('@heroui/react', () => ({
  Spinner: (props: Record<string, unknown>) => createElement(
    'span',
    { ...props, 'data-spinner': true }
  )
}));

const { CodexSessionList } = await import(
  '../src/features/codex-sessions/codex-session-list'
);

function connector(
  overrides: Partial<MachineRecord['connector']> = {}
): MachineRecord {
  return {
    connector: {
      capabilities: ['runtime.restart', 'runtime.update'],
      installCommand: 'project connector install',
      runtime: {
        architecture: 'arm64',
        buildId: 'build-1',
        bundleVersions: {
          connector: '0.4.9',
          machineTools: '0.4.9',
          projectCli: '0.4.9'
        },
        channel: 'stable',
        instanceId: 'instance-current',
        lastCheckedAt: '2026-07-21T08:00:00.000Z',
        platform: 'darwin',
        protocolVersion: '2',
        releaseId: 'v0.4.9',
        source: 'managed',
        version: '0.4.9'
      },
      status: 'online',
      update: { state: 'up-to-date' },
      ...overrides
    },
    id: 'machine-mac',
    kind: 'connector',
    name: 'os-macbook',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function inventory(
  overrides: Partial<CodexMachine> = {}
): CodexMachine {
  return {
    id: 'machine-mac',
    inventoryPublishedAt: '2026-07-21T08:00:00.000Z',
    name: 'os-macbook',
    status: 'connected',
    ...overrides
  };
}

function renderList(
  machine: CodexMachine | undefined,
  installation: MachineRecord | null = connector(),
  sessions: CodexSession[] = [],
  query = '',
  now = new Date('2026-07-21T08:00:00.000Z')
) {
  return renderToStaticMarkup(
    <CodexSessionList
      connectorInstallations={installation ? [installation] : []}
      machines={machine ? [machine] : []}
      now={now}
      onManageConnector={() => {}}
      onSelect={() => {}}
      query={query}
      sessions={sessions}
      setQuery={() => {}}
    />
  );
}

describe('Codex inventory truth UI', () => {
  test('does not claim zero sessions while the first live inventory is checking', () => {
    const html = renderList(undefined, connector({
      capabilities: ['codex.sessions.v1', 'runtime.restart', 'runtime.update']
    }));

    expect(html).toContain('Checking');
    expect(html).not.toContain('0 sessions');
    expect(html).not.toContain('reported no Codex sessions');
  });

  test('requires an approved update when the current connector lacks Codex support', () => {
    const html = renderList(undefined, connector({
      update: {
        availableReleaseId: 'v0.4.10',
        availableVersion: '0.4.10',
        state: 'update-available'
      }
    }));

    expect(html).toContain('Update required');
    expect(html).toContain('Manage connector');
    expect(html.split('This connector does not provide Codex sessions.').length - 1).toBe(1);
    expect(html.split('Manage connector').length - 1).toBe(1);
    expect(html).not.toContain('0 sessions');
  });

  test('claims a genuine empty inventory only for the matching live connector instance', () => {
    const html = renderList(inventory({
      inventoryConnectorInstanceId: 'instance-current',
      inventoryState: 'live'
    }), connector({
      capabilities: ['codex.sessions.v1', 'runtime.restart', 'runtime.update']
    }));

    expect(html).toContain('0 sessions');
    expect(html).toContain('The compatible connector reported no Codex sessions.');
    expect(html).toContain('Ready');
  });

  test('returns an old live empty inventory to Checking after its evidence expires', () => {
    const html = renderList(inventory({
      inventoryConnectorInstanceId: 'instance-current',
      inventoryState: 'live'
    }), connector({
      capabilities: ['codex.sessions.v1', 'runtime.restart', 'runtime.update']
    }), [], '', new Date('2026-07-21T08:00:16.000Z'));

    expect(html).toContain('Checking');
    expect(html).toContain('no longer fresh');
    expect(html).not.toContain('0 sessions');
    expect(html).not.toContain('reported no Codex sessions');
  });

  test('keeps a saved empty inventory blocked instead of presenting it as empty', () => {
    const html = renderList(inventory({
      inventoryConnectorInstanceId: 'instance-current',
      inventoryState: 'stale',
      status: 'offline',
      statusDetail: 'Showing the last saved session inventory.'
    }), connector({
      capabilities: ['codex.sessions.v1', 'runtime.restart', 'runtime.update']
    }));

    expect(html).toContain('Blocked');
    expect(html).toContain('Showing the last saved session inventory.');
    expect(html).not.toContain('0 sessions');
  });

  test('does not reuse old live evidence after the connector leaves the authenticated overview', () => {
    const html = renderList(inventory({
      inventoryConnectorInstanceId: 'instance-current',
      inventoryState: 'live'
    }), null);

    expect(html).toContain('Blocked');
    expect(html).not.toContain('0 sessions');
    expect(html).not.toContain('reported no Codex sessions');
  });

  test('does not count cached sessions owned by a removed connector', () => {
    const html = renderList(inventory({
      inventoryConnectorInstanceId: 'instance-current',
      inventoryState: 'live'
    }), connector({
      capabilities: ['codex.sessions.v1', 'runtime.restart', 'runtime.update']
    }), [{
      lastActivityAt: '2026-07-21T07:00:00.000Z',
      loadedByProjectSpace: true,
      machineId: 'machine-removed',
      status: 'idle',
      stored: true,
      threadId: 'thread-removed',
      title: 'Cached task from removed connector'
    }]);

    expect(html).toContain('0 sessions');
    expect(html).not.toContain('1 sessions');
    expect(html).not.toContain('Cached task from removed connector');
  });

  test('keeps the blocked reason and recovery action when search has no matches', () => {
    const html = renderList(undefined, connector({
      update: {
        availableReleaseId: 'v0.4.10',
        availableVersion: '0.4.10',
        state: 'update-available'
      }
    }), [], 'does-not-match');

    expect(html.split('This connector does not provide Codex sessions.').length - 1).toBe(1);
    expect(html.split('Manage connector').length - 1).toBe(1);
    expect(html).not.toContain('0 sessions');
  });

  test('shows each blocked machine reason once when another machine has cached sessions', () => {
    const update = {
      availableReleaseId: 'v0.4.10',
      availableVersion: '0.4.10',
      state: 'update-available' as const
    };
    const firstConnector = connector({ update });
    const secondConnector = {
      ...connector({ update }),
      id: 'machine-pc',
      name: 'os-pc'
    };
    const html = renderToStaticMarkup(
      <CodexSessionList
        connectorInstallations={[firstConnector, secondConnector]}
        machines={[]}
        now={new Date('2026-07-21T08:00:00.000Z')}
        onManageConnector={() => {}}
        onSelect={() => {}}
        query=""
        sessions={[{
          lastActivityAt: '2026-07-21T07:00:00.000Z',
          loadedByProjectSpace: true,
          machineId: firstConnector.id,
          status: 'idle',
          stored: true,
          threadId: 'thread-cached',
          title: 'Cached task'
        }]}
        setQuery={() => {}}
      />
    );

    expect(html.split('This connector does not provide Codex sessions.').length - 1).toBe(2);
    expect(html.split('Manage connector').length - 1).toBe(2);
    expect(html).toContain('Cached task');
    expect(html).not.toContain('0 sessions');
  });

  test('keeps a filtered-out blocked machine visible beside a matching ready machine', () => {
    const readyConnector = connector({
      capabilities: ['codex.sessions.v1', 'runtime.restart', 'runtime.update']
    });
    const blockedConnector = {
      ...connector({
        update: {
          availableReleaseId: 'v0.4.10',
          availableVersion: '0.4.10',
          state: 'update-available'
        }
      }),
      id: 'machine-pc',
      name: 'os-pc'
    };
    const html = renderToStaticMarkup(
      <CodexSessionList
        connectorInstallations={[readyConnector, blockedConnector]}
        machines={[inventory({
          inventoryConnectorInstanceId: 'instance-current',
          inventoryState: 'live'
        })]}
        now={new Date('2026-07-21T08:00:00.000Z')}
        onManageConnector={() => {}}
        onSelect={() => {}}
        query="matching"
        sessions={[{
          lastActivityAt: '2026-07-21T07:00:00.000Z',
          loadedByProjectSpace: true,
          machineId: readyConnector.id,
          status: 'idle',
          stored: true,
          threadId: 'thread-matching',
          title: 'Matching task'
        }]}
        setQuery={() => {}}
      />
    );

    expect(html).toContain('Matching task');
    expect(html).toContain('os-pc');
    expect(html.split('This connector does not provide Codex sessions.').length - 1).toBe(1);
    expect(html.split('Manage connector').length - 1).toBe(1);
    expect(html).not.toContain('0 sessions');
  });
});
