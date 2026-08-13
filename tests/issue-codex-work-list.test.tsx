import { describe, expect, mock, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  CodexMachineTaskExistingResult,
  CodexMachineTaskStartResult
} from '../src/shared/codex-machine-tasks-api';
import type { CodexSessionRecord } from '../src/shared/codex-sessions-api';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';
import type { CodexMachine, CodexSession } from '../src/features/codex-sessions/codex-sessions-types';
import type {
  IssueMachineConnectorOption,
  IssueMachineProjectRow
} from '../src/features/project-desktop/components/issue-development-machine-actions';
import {
  issueCodexConnectorTargets,
  issueCodexInventoryVerification,
  issueCodexInventoryTasks,
  presentIssueCodexStartResult,
  presentIssueCodexInventoryThread,
  presentIssueCodexThread
} from '../src/features/project-desktop/components/issue-codex-work-list-model';

mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {
    getExistingCodexMachineTask: () => Promise.resolve({ apiVersion: 1, state: 'missing' }),
    startCodexMachineTask: () => Promise.reject(new Error('Not used during server rendering.'))
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

const { groupIssueCodexTargetsByHost, IssueCodexWorkList } = await import(
  '../src/features/project-desktop/components/issue-codex-work-list'
);
const {
  issueCodexThreadPresentation,
  mergeIssueCodexThreadEntries
} = await import('../src/features/project-desktop/components/issue-codex-thread-row');

function option(
  connectorId: string,
  environmentId: string,
  environmentLabel: string,
  isOnline = true
): IssueMachineConnectorOption {
  return {
    canRunCommand: isOnline,
    connectorId,
    connectorName: `${environmentLabel} connector`,
    environmentId,
    environmentLabel,
    hasProjectCheckout: isOnline,
    isOnline
  };
}

function pcRow(): IssueMachineProjectRow {
  return {
    connectorOptions: [
      option('connector-windows', 'environment-windows', 'Windows 11', false),
      option('connector-wsl', 'environment-wsl', 'WSL · Ubuntu 24.04')
    ],
    machineId: 'connector-wsl',
    physicalMachineId: 'physical-pc',
    physicalMachineName: 'os-pc',
    suggestedConnectorId: 'connector-wsl'
  };
}

function session(overrides: Partial<CodexSessionRecord> = {}): CodexSessionRecord {
  return {
    archived: false,
    id: '11111111-1111-4111-8111-111111111111',
    lastActivityAt: '2026-08-10T10:00:00.000Z',
    loadedByProjectSpace: true,
    machineId: 'connector-wsl',
    machineName: 'Ubuntu connector',
    status: 'idle',
    title: 'Move shared UI components',
    ...overrides
  };
}

function inventorySession(overrides: Partial<CodexSession> = {}): CodexSession {
  return {
    lastActivityAt: '2026-08-10T10:00:00.000Z',
    loadedByProjectSpace: true,
    machineId: 'connector-wsl',
    status: 'idle',
    stored: true,
    taskIdentity: {
      issueNumber: 596,
      repository: 'DotNaos/project-space'
    },
    threadId: '11111111-1111-4111-8111-111111111111',
    title: 'Move shared UI components',
    ...overrides
  };
}

function confirmed(
  action: 'continue' | 'open-running' | 'resolve',
  sessionRecord = session()
): Extract<CodexMachineTaskExistingResult, { state: 'confirmed' }> {
  return {
    action,
    apiVersion: 1,
    session: sessionRecord,
    state: 'confirmed',
    task: {
      canonicalTaskUrl: 'https://projects.example.test/codex/task',
      connector: {
        generation: 1,
        id: sessionRecord.machineId,
        name: sessionRecord.machineName
      },
      issue: { number: 596, url: 'https://github.com/DotNaos/project-space/issues/596' },
      physicalMachine: { id: 'physical-pc', name: 'os-pc' },
      repository: { id: 'DotNaos/project-space', nameWithOwner: 'DotNaos/project-space' },
      threadId: sessionRecord.id,
      worktree: { branch: 'issue-596', id: 'worktree-596' }
    }
  };
}

describe('issue Codex work list', () => {
  test('groups connectors from duplicate topology records into one named host', () => {
    const groups = groupIssueCodexTargetsByHost([
      {
        connectorId: 'connector-pc-windows',
        environmentLabel: 'Windows',
        isOnline: false,
        key: 'physical-pc-windows:connector-pc-windows:windows',
        physicalMachineId: 'physical-pc-windows',
        physicalMachineName: 'os-pc',
        row: { machineId: 'connector-pc-windows' }
      },
      {
        connectorId: 'connector-pc-wsl',
        environmentLabel: 'WSL',
        isOnline: false,
        key: 'physical-pc-wsl:connector-pc-wsl:wsl',
        physicalMachineId: 'physical-pc-wsl',
        physicalMachineName: 'os-pc',
        row: { machineId: 'connector-pc-wsl' }
      }
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.name).toBe('os-pc');
    expect(groups[0]?.targets.map((target) => target.connectorId)).toEqual([
      'connector-pc-windows',
      'connector-pc-wsl'
    ]);
  });

  test('keeps Windows and WSL as exact environments on one physical machine', () => {
    const targets = issueCodexConnectorTargets([pcRow()]);

    expect(targets.map((target) => ({
      connectorId: target.connectorId,
      environmentId: target.environmentId,
      environmentLabel: target.environmentLabel,
      machineIdForStart: target.row.machineId,
      physicalMachineName: target.physicalMachineName
    }))).toEqual([
      {
        connectorId: 'connector-wsl',
        environmentId: 'environment-wsl',
        environmentLabel: 'WSL · Ubuntu 24.04',
        machineIdForStart: 'connector-wsl',
        physicalMachineName: 'os-pc'
      },
      {
        connectorId: 'connector-windows',
        environmentId: 'environment-windows',
        environmentLabel: 'Windows 11',
        machineIdForStart: 'connector-windows',
        physicalMachineName: 'os-pc'
      }
    ]);
    expect(targets[0]?.row.connectorOptions?.map(({ connectorId }) => connectorId)).toEqual([
      'connector-wsl'
    ]);
    expect(targets[1]?.row.connectorOptions?.map(({ connectorId }) => connectorId)).toEqual([
      'connector-windows'
    ]);
  });

  test('does not turn a physical machine without a connector into a connector target', () => {
    expect(issueCodexConnectorTargets([{
      connectorOptions: [],
      machineId: 'physical-build',
      physicalMachineId: 'physical-build',
      physicalMachineName: 'build-linux'
    }])).toEqual([]);
  });

  test('keeps online physical machines ahead of alphabetically earlier offline machines', () => {
    const targets = issueCodexConnectorTargets([{
      connectorOptions: [option('connector-offline', 'environment-offline', 'Linux', false)],
      machineId: 'connector-offline',
      physicalMachineId: 'physical-a',
      physicalMachineName: 'a-build'
    }, {
      connectorOptions: [option('connector-online', 'environment-online', 'macOS')],
      machineId: 'connector-online',
      physicalMachineId: 'physical-z',
      physicalMachineName: 'z-workstation'
    }]);

    expect(targets.map((target) => target.physicalMachineName)).toEqual([
      'z-workstation',
      'a-build'
    ]);
  });

  test('requires a successful live inventory from the exact connector instance before start', () => {
    const target = { connectorId: 'connector-wsl', connectorInstanceId: 'instance-current' };
    const machine: CodexMachine = {
      id: target.connectorId,
      inventoryConnectorInstanceId: target.connectorInstanceId,
      inventoryState: 'live',
      name: 'WSL connector',
      status: 'connected'
    };
    const verification = (override: Partial<CodexMachine> = {}, checked = true) =>
      issueCodexInventoryVerification({
        checked,
        loadingMachineIds: [],
        machines: [{ ...machine, ...override }],
        targets: [target]
      });

    expect(verification({}, false).pendingConnectorIds.has(target.connectorId)).toBe(true);
    expect(verification().verifiedConnectorIds.has(target.connectorId)).toBe(true);
    expect(verification({ status: 'offline' }).blockedReasons.has(target.connectorId)).toBe(true);
    expect(verification({ status: 'unavailable' }).blockedReasons.has(target.connectorId)).toBe(true);
    expect(verification({ inventoryState: 'stale' }).blockedReasons.has(target.connectorId)).toBe(true);
    expect(verification({ inventoryConnectorInstanceId: 'instance-old' }).blockedReasons.has(
      target.connectorId
    )).toBe(true);
  });

  test('presents running and waiting tasks from canonical activity evidence', () => {
    const running = presentIssueCodexThread(confirmed('open-running', session({
      activity: {
        conversationState: 'running',
        currentPhase: 'Moving components',
        currentTurnState: 'running',
        evidenceRevision: 'revision-1',
        freshness: 'live',
        lastEventAt: '2026-08-10T10:00:00.000Z',
        latestActivity: 'Editing shared components',
        machineState: 'online',
        processState: 'ready'
      },
      status: 'active'
    })));
    const waiting = presentIssueCodexThread(confirmed('resolve', session({
      attention: 'input',
      status: 'active'
    })));
    const approval = presentIssueCodexThread(confirmed('resolve', session({
      attention: 'approval',
      status: 'active'
    })));

    expect(running).toMatchObject({
      actionLabel: 'Open',
      running: true,
      state: 'running',
      stateLabel: 'Running'
    });
    expect(waiting).toMatchObject({
      actionLabel: 'Resolve',
      running: false,
      state: 'attention',
      stateLabel: 'Waiting for input'
    });
    expect(approval).toMatchObject({
      actionLabel: 'Resolve',
      running: false,
      state: 'attention',
      stateLabel: 'Waiting for approval'
    });
  });

  test('includes every matching inventory thread and excludes unrelated or archived tasks', () => {
    const targets = issueCodexConnectorTargets([pcRow()]);
    const first = inventorySession();
    const second = inventorySession({
      threadId: '22222222-2222-4222-8222-222222222222',
      title: 'Review extraction plan'
    });
    const tasks = issueCodexInventoryTasks({
      issueNumber: 596,
      repositoryId: 'DotNaos/project-space',
      sessions: [
        first,
        second,
        inventorySession({
          taskIdentity: { issueNumber: 597, repository: 'DotNaos/project-space' },
          threadId: 'foreign-issue'
        }),
        inventorySession({
          taskIdentity: { issueNumber: 596, repository: 'DotNaos/other-space' },
          threadId: 'foreign-repository'
        }),
        inventorySession({
          taskIdentity: { issueNumber: 596, repository: 'project-space' },
          threadId: 'ambiguous-repository'
        }),
        inventorySession({ status: 'archived', threadId: 'archived' })
      ],
      targets
    });

    expect(tasks.map((task) => task.session.threadId)).toEqual([
      first.threadId,
      second.threadId
    ]);
    expect(tasks.every((task) => task.environmentLabel === 'WSL · Ubuntu 24.04')).toBe(true);
  });

  test('accepts basename identity only inside an owner-verified project scope', () => {
    const targets = issueCodexConnectorTargets([pcRow()]);
    const project: ProjectSpaceRecord = {
      github: { fullName: 'DotNaos/project-space' } as ProjectSpaceRecord['github'],
      id: 'connector-project:project-space',
      kind: 'standalone',
      machineId: 'connector-wsl',
      name: 'project-space',
      rootPath: '/home/oli/projects/project-space'
    };
    const target = targets.find((candidate) => candidate.connectorId === 'connector-wsl');
    if (!target) throw new Error('Expected the WSL target.');
    target.row.project = project;
    const scoped = inventorySession({
      cwd: '/home/oli/projects/.worktrees/project-space/issue-596-machine-aware/src',
      taskIdentity: { issueNumber: 596, repository: 'project-space' }
    });

    expect(issueCodexInventoryTasks({
      issueNumber: 596,
      repositoryId: 'DotNaos/project-space',
      sessions: [scoped],
      targets
    })).toHaveLength(1);
    target.row.project = {
      ...project,
      github: { fullName: 'Other/project-space' } as ProjectSpaceRecord['github']
    };
    expect(issueCodexInventoryTasks({
      issueNumber: 596,
      repositoryId: 'DotNaos/project-space',
      sessions: [scoped],
      targets
    })).toHaveLength(0);
  });

  test('deduplicates a durable association with its fresher inventory session', () => {
    const result = confirmed('continue');
    const inventory = inventorySession({ title: 'Fresh inventory title' });
    const entries = mergeIssueCodexThreadEntries([{
      environmentLabel: 'WSL · Ubuntu 24.04',
      key: 'durable',
      kind: 'associated' as const,
      physicalMachineName: 'os-pc',
      result
    }], [{
      environmentLabel: 'Connector fallback',
      key: 'inventory',
      kind: 'inventory' as const,
      physicalMachineName: 'Connector fallback',
      session: inventory
    }]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      environmentLabel: 'WSL · Ubuntu 24.04',
      kind: 'inventory',
      physicalMachineName: 'os-pc',
      session: { title: 'Fresh inventory title' }
    });
  });

  test('does not replace fresh running evidence with a stale inventory copy', () => {
    const liveActivity = {
      conversationState: 'running' as const,
      currentPhase: 'Moving components',
      currentTurnState: 'running' as const,
      evidenceRevision: 'live-revision',
      freshness: 'live' as const,
      lastEventAt: '2026-08-10T10:01:00.000Z',
      latestActivity: 'Editing shared components',
      machineState: 'online' as const,
      processState: 'ready' as const
    };
    const durable = confirmed('open-running', session({ activity: liveActivity, status: 'active' }));
    const stale = inventorySession({
      activity: {
        ...liveActivity,
        evidenceRevision: 'stale-revision',
        freshness: 'stale',
        machineState: 'offline'
      },
      status: 'offline'
    });
    const entries = mergeIssueCodexThreadEntries([{
      environmentLabel: 'WSL · Ubuntu 24.04',
      key: 'durable-running',
      kind: 'associated' as const,
      physicalMachineName: 'os-pc',
      result: durable
    }], [{
      environmentLabel: 'WSL · Ubuntu 24.04',
      key: 'inventory-stale',
      kind: 'inventory' as const,
      physicalMachineName: 'os-pc',
      session: stale
    }]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'associated' });
  });

  test('shows completed and failed inventory states explicitly', () => {
    const activity = {
      conversationState: 'completed' as const,
      currentPhase: 'Complete',
      currentTurnState: 'idle' as const,
      evidenceRevision: 'revision-complete',
      freshness: 'live' as const,
      lastEventAt: '2026-08-10T10:00:00.000Z',
      latestActivity: 'Finished extraction',
      machineState: 'online' as const,
      processState: 'ready' as const
    };
    expect(presentIssueCodexInventoryThread(inventorySession({ activity }), 596)).toMatchObject({
      actionLabel: 'Continue',
      stateLabel: 'Completed'
    });
    expect(presentIssueCodexInventoryThread(inventorySession({
      activity: { ...activity, conversationState: 'failed', latestActivity: 'Tests failed' }
    }), 596)).toMatchObject({
      actionLabel: 'Resolve',
      stateLabel: 'Failed'
    });
  });

  test('keeps an offline durable Codespace task visible as last known', () => {
    const result = confirmed('resolve');
    delete result.session;
    expect(issueCodexThreadPresentation({
      environmentLabel: 'Codespace · task-space',
      isOnline: false,
      key: 'codespace:connector',
      kind: 'associated',
      physicalMachineName: 'GitHub Codespace',
      result
    }, 596)).toMatchObject({
      actionLabel: 'Resolve',
      running: false,
      state: 'offline',
      stateLabel: 'Offline / last known'
    });
  });

  test('lets exact offline connectivity override a previously live Codespace session', () => {
    const result = confirmed('open-running', session({ status: 'active' }));
    const entries = mergeIssueCodexThreadEntries([{
      environmentLabel: 'Codespace · task-space',
      key: 'codespace-connector',
      kind: 'associated' as const,
      physicalMachineName: 'GitHub Codespace',
      result
    }, {
      environmentLabel: 'Codespace · task-space',
      isOnline: false,
      key: 'codespace-connector',
      kind: 'associated' as const,
      physicalMachineName: 'GitHub Codespace',
      result
    }], []);

    expect(entries).toHaveLength(1);
    expect(issueCodexThreadPresentation(entries[0]!, 596)).toMatchObject({
      actionLabel: 'Resolve',
      running: false,
      state: 'offline',
      stateLabel: 'Offline / last known'
    });
  });

  test('keeps the richer session when duplicate task lookups finish at different times', () => {
    const withoutSession = confirmed('resolve');
    delete withoutSession.session;
    const withSession = confirmed('open-running', session({
      status: 'active',
      title: 'Current Codespace work'
    }));
    const entries = mergeIssueCodexThreadEntries([{
      environmentLabel: 'Codespace · task-space',
      key: 'codespace-first',
      kind: 'associated' as const,
      physicalMachineName: 'GitHub Codespace',
      result: withoutSession
    }, {
      environmentLabel: 'Codespace · task-space',
      key: 'codespace-second',
      kind: 'associated' as const,
      physicalMachineName: 'GitHub Codespace',
      result: withSession
    }], []);

    expect(entries).toHaveLength(1);
    expect(issueCodexThreadPresentation(entries[0]!, 596)).toMatchObject({
      running: true,
      state: 'running',
      title: 'Current Codespace work'
    });
  });

  test('keeps exact offline connectivity when inventory replaces associated evidence', () => {
    const result = confirmed('open-running', session({ status: 'active' }));
    const entries = mergeIssueCodexThreadEntries([{
      environmentLabel: 'Codespace · task-space',
      isOnline: false,
      key: 'codespace-associated',
      kind: 'associated' as const,
      physicalMachineName: 'GitHub Codespace',
      result
    }], [{
      environmentLabel: 'Codespace connector',
      key: 'codespace-inventory',
      kind: 'inventory' as const,
      physicalMachineName: 'Codespace connector',
      session: inventorySession({
        lastActivityAt: '2026-08-10T10:02:00.000Z',
        machineId: 'connector-wsl',
        status: 'active'
      })
    }]);

    expect(entries).toHaveLength(1);
    expect(issueCodexThreadPresentation(entries[0]!, 596)).toMatchObject({
      actionLabel: 'Resolve',
      running: false,
      state: 'offline'
    });
  });

  test('maps a stale connector block to a concise label without losing the exact message', () => {
    const result: Extract<CodexMachineTaskStartResult, { state: 'blocked' }> = {
      apiVersion: 1,
      message: 'Connector generation 4 is stale; generation 6 is required.',
      operationId: 'issue-codex-readiness:test',
      reason: 'stale_connector',
      state: 'blocked'
    };

    expect(presentIssueCodexStartResult(result)).toEqual({
      canStart: false,
      message: 'Connector generation 4 is stale; generation 6 is required.',
      state: 'blocked',
      stateLabel: 'Connector state stale'
    });
  });

  test('mixes an external Codespace task into the consolidated list but not start targets', () => {
    const result = confirmed('continue', session({
      machineId: 'codespace-connector',
      machineName: 'Codespace connector',
      title: 'Review extraction plan'
    }));
    const html = renderToStaticMarkup(
      <IssueCodexWorkList
        canStart={false}
        externalTasks={[{
          environmentLabel: 'Codespace · bug-free-space-invention',
          key: 'codespace-task',
          physicalMachineName: 'GitHub Codespace',
          result
        }]}
        issueNumber={596}
        machineRows={[]}
        onError={() => undefined}
        onStart={() => undefined}
        renderThreadControls={() => <span>Codespace lifecycle controls</span>}
        repositoryId="DotNaos/project-space"
      />
    );

    expect(html).toContain('Threads');
    expect(html).toContain('>1</span>');
    expect(html).toContain('Review extraction plan');
    expect(html).toContain('GitHub Codespace · bug-free-space-invention');
    expect(html).toContain('Codespace lifecycle controls');
    expect(html).not.toContain('Start new thread');
  });

  test('keeps the Codespaces provider visible while canonical and inventory discovery runs', () => {
    const html = renderToStaticMarkup(
      <IssueCodexWorkList
        canStart
        cloudDestination={<span>Codespace chooser</span>}
        issueNumber={596}
        lookupTargets={[{
          connectorId: 'codespace-connector',
          connectorInstanceId: 'codespace-instance',
          environmentLabel: 'Codespace · task-space',
          key: 'codespace-connector',
          physicalMachineName: 'GitHub Codespace'
        }]}
        machineRows={[]}
        onError={() => undefined}
        onStart={() => undefined}
        repositoryId="DotNaos/project-space"
      />
    );

    expect(html).toContain('Checking existing threads…');
    expect(html).toContain('GitHub Codespace available');
  });

  test('keeps the Codespaces provider available when only a stale offline connector exists', () => {
    const html = renderToStaticMarkup(
      <IssueCodexWorkList
        canStart
        cloudDestination={<span>Codespace chooser</span>}
        issueNumber={596}
        lookupTargets={[{
          connectorId: 'codespace-offline',
          connectorInstanceId: 'codespace-instance',
          environmentLabel: 'Codespace · old-runner',
          isOnline: false,
          key: 'codespace-offline',
          physicalMachineName: 'GitHub Codespace'
        }]}
        machineRows={[{
          connectorOptions: [option(
            'codespace-offline',
            'environment-codespace',
            'Codespace · old-runner',
            false
          )],
          machineId: 'codespace-offline',
          physicalMachineName: 'GitHub Codespace'
        }]}
        onError={() => undefined}
        onStart={() => undefined}
        repositoryId="DotNaos/project-space"
      />
    );

    expect(html).toContain('GitHub Codespace available');
    expect(html).not.toContain('GitHub Codespace · Codespace · old-runner');
  });

  test('summarizes runner availability without rendering the chooser inline', () => {
    const html = renderToStaticMarkup(
      <IssueCodexWorkList
        canStart
        expectedBranch="issue-596"
        expectedCommit="0123456789abcdef0123456789abcdef01234567"
        issueNumber={596}
        machineRows={[pcRow()]}
        onError={() => undefined}
        onStart={() => undefined}
        repositoryId="DotNaos/project-space"
      />
    );

    expect(html).toContain('Runner');
    expect(html).toContain('1 environment available');
    expect(html).toContain('Start development');
    expect(html).not.toContain('os-pc');
    expect(html).not.toContain('Windows 11');
    expect(html).not.toContain('WSL · Ubuntu 24.04');
  });

  test('moves Codespace launch progress onto the task page', () => {
    const html = renderToStaticMarkup(
      <IssueCodexWorkList
        canStart
        cloudDestination={<span>Codespace chooser</span>}
        cloudLaunchStatus={{
          kind: 'pending',
          message: 'The Codespace is installing and connecting its managed runner.'
        }}
        issueNumber={596}
        machineRows={[]}
        onError={() => undefined}
        onStart={() => undefined}
        repositoryId="DotNaos/project-space"
      />
    );

    expect(html).toContain('The Codespace is installing and connecting its managed runner.');
    expect(html).toContain('Starting development…');
    expect(html).toContain('disabled');
  });

  test('shows a truthful initial loading state before the first task check finishes', () => {
    const html = renderToStaticMarkup(
      <IssueCodexWorkList
        canStart={false}
        issueNumber={596}
        machineRows={[]}
        onError={() => undefined}
        onStart={() => undefined}
        repositoryId="DotNaos/project-space"
      />
    );

    expect(html).toContain('Checking existing threads…');
    expect(html).not.toContain('No threads exist for this task yet.');
  });
});
