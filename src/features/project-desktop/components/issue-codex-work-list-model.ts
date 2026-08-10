import type {
  CodexMachineTaskBlockedReason,
  CodexMachineTaskExistingResult,
  CodexMachineTaskStartResult
} from '@/shared/codex-machine-tasks-api';
import type { CodexSessionStatus } from '@/shared/codex-sessions-api';
import type { CodexMachine, CodexSession } from '../../codex-sessions/codex-sessions-types';
import { projectForCodexSession } from '../../codex-sessions/project-codex-task-model';
import type {
  IssueMachineConnectorOption,
  IssueMachineProjectRow
} from './issue-development-machine-actions';
import { canRunMachineCommand } from './issue-development-machine-actions';

export interface IssueCodexInventoryTarget {
  connectorId: string;
  connectorInstanceId?: string;
}

export interface IssueCodexConnectorTarget extends IssueCodexInventoryTarget {
  environmentId?: string;
  environmentLabel: string;
  isOnline: boolean;
  key: string;
  physicalMachineId?: string;
  physicalMachineName: string;
  row: IssueMachineProjectRow;
}

export interface IssueCodexInventoryTask {
  environmentLabel: string;
  key: string;
  physicalMachineName: string;
  session: CodexSession;
}

export type IssueCodexThreadState = 'attention' | 'offline' | 'ready' | 'running';

export interface IssueCodexThreadPresentation {
  actionLabel?: 'Continue' | 'Open' | 'Resolve';
  activityAt?: string;
  activityLabel: string;
  message?: string;
  running: boolean;
  state: IssueCodexThreadState;
  stateLabel: string;
  title: string;
}

export interface IssueCodexStartPresentation {
  canStart: boolean;
  message: string;
  state: 'attention' | 'blocked' | 'checking' | 'ready' | 'unavailable';
  stateLabel: string;
}

function environmentLabel(row: IssueMachineProjectRow, option?: IssueMachineConnectorOption) {
  return option?.environmentLabel
    ?? option?.environmentName
    ?? row.machine?.compute?.environmentName
    ?? row.machine?.environment?.label
    ?? option?.connectorName
    ?? row.machine?.name
    ?? 'Default environment';
}

function optionRow(
  row: IssueMachineProjectRow,
  option?: IssueMachineConnectorOption
): IssueMachineProjectRow {
  if (!option) return row;
  return {
    connectorIds: [option.connectorId],
    connectorOptions: [option],
    environmentId: option.environmentId,
    machine: option.machine,
    machineId: option.connectorId,
    physicalMachineId: row.physicalMachineId,
    physicalMachineName: row.physicalMachineName,
    project: option.project,
    suggestedConnectorId: option.connectorId
  };
}

/**
 * Expands physical-machine rows into exact connector/environment targets.
 * Older callers without connectorOptions retain their single legacy target.
 */
export function issueCodexConnectorTargets(
  rows: readonly IssueMachineProjectRow[]
): IssueCodexConnectorTarget[] {
  const targets = new Map<string, IssueCodexConnectorTarget>();

  for (const row of rows) {
    const options = row.connectorOptions === undefined ? [undefined] : row.connectorOptions;
    for (const option of options) {
      const connectorId = option?.connectorId ?? row.machineId;
      const environmentId = option?.environmentId ?? row.environmentId;
      const physicalMachineName = row.physicalMachineName
        ?? row.machine?.name
        ?? option?.connectorName
        ?? connectorId;
      const key = [row.physicalMachineId ?? physicalMachineName, connectorId, environmentId ?? 'default']
        .map(encodeURIComponent)
        .join(':');
      if (targets.has(key)) continue;
      targets.set(key, {
        connectorId,
        connectorInstanceId: option?.machine?.connector.runtime?.instanceId
          ?? row.machine?.connector.runtime?.instanceId,
        environmentId,
        environmentLabel: environmentLabel(row, option),
        isOnline: option?.isOnline ?? canRunMachineCommand(row.machine),
        key,
        physicalMachineId: row.physicalMachineId,
        physicalMachineName,
        row: optionRow(row, option)
      });
    }
  }

  return [...targets.values()].sort((left, right) =>
    Number(right.isOnline) - Number(left.isOnline)
    || left.physicalMachineName.localeCompare(right.physicalMachineName)
    || left.environmentLabel.localeCompare(right.environmentLabel)
    || left.connectorId.localeCompare(right.connectorId));
}

export function issueCodexInventoryVerification({
  checked,
  loadingMachineIds,
  machines,
  targets
}: {
  checked: boolean;
  loadingMachineIds: readonly string[];
  machines: readonly CodexMachine[];
  targets: readonly IssueCodexInventoryTarget[];
}) {
  const blockedReasons = new Map<string, string>();
  const pendingConnectorIds = new Set<string>();
  const verifiedConnectorIds = new Set<string>();
  const loading = new Set(loadingMachineIds);
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));

  for (const target of targets) {
    if (!checked || loading.has(target.connectorId)) {
      pendingConnectorIds.add(target.connectorId);
      verifiedConnectorIds.delete(target.connectorId);
      continue;
    }
    const machine = machineById.get(target.connectorId);
    const reason = !machine
      ? 'A complete current task inventory is unavailable for this connector.'
      : machine.status === 'offline'
        ? machine.statusDetail ?? 'The connector is offline, so current tasks could not be verified.'
        : machine.status === 'unavailable'
          ? machine.statusDetail ?? 'Existing tasks could not be verified for this connector.'
          : machine.inventoryState !== 'live'
            ? machine.statusDetail ?? 'A complete current task inventory is unavailable for this connector.'
            : target.connectorInstanceId
                && machine.inventoryConnectorInstanceId !== target.connectorInstanceId
              ? 'The connector changed while its task inventory was checked.'
              : undefined;
    if (reason) {
      blockedReasons.set(target.connectorId, reason);
      verifiedConnectorIds.delete(target.connectorId);
    } else if (!blockedReasons.has(target.connectorId) && !pendingConnectorIds.has(target.connectorId)) {
      verifiedConnectorIds.add(target.connectorId);
    }
  }
  return { blockedReasons, pendingConnectorIds, verifiedConnectorIds };
}

function offlineStatus(status: CodexSessionStatus | undefined) {
  return status === 'archived'
    || status === 'missing'
    || status === 'offline'
    || status === 'unavailable';
}

function normalizedRepository(value: string | undefined) {
  return value
    ?.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLocaleLowerCase() ?? '';
}

function repositoryMatchesScopedProject(
  session: CodexSession,
  repositoryId: string,
  target: IssueCodexConnectorTarget | undefined
) {
  const identity = normalizedRepository(session.taskIdentity?.repository);
  const repository = normalizedRepository(repositoryId);
  if (!identity || !repository) return false;
  if (identity === repository) return true;
  if (identity.includes('/') || identity !== repository.split('/').at(-1)) return false;
  const project = target?.row.project;
  return normalizedRepository(project?.github?.fullName) === repository
    && projectForCodexSession(session, project ? [project] : [])?.id === project?.id;
}

/**
 * Selects every non-archived inventory thread carrying canonical issue identity.
 * Durable start associations are merged separately and remain the start lock.
 */
export function issueCodexInventoryTasks({
  issueNumber,
  machineNames = {},
  repositoryId,
  sessions,
  targets
}: {
  issueNumber: number;
  machineNames?: Readonly<Record<string, string | undefined>>;
  repositoryId: string;
  sessions: readonly CodexSession[];
  targets: readonly IssueCodexConnectorTarget[];
}): IssueCodexInventoryTask[] {
  const targetByConnector = new Map(targets.map((target) => [target.connectorId, target]));
  return sessions.flatMap((session): IssueCodexInventoryTask[] => {
    const target = targetByConnector.get(session.machineId);
    if (
      session.status === 'archived'
      || session.taskIdentity?.issueNumber !== issueNumber
      || !repositoryMatchesScopedProject(session, repositoryId, target)
    ) {
      return [];
    }
    const fallbackName = machineNames[session.machineId] ?? session.machineId;
    return [{
      environmentLabel: target?.environmentLabel
        ?? session.taskIdentity.codespaceName
        ?? fallbackName,
      key: `inventory:${session.machineId}:${session.threadId}`,
      physicalMachineName: target?.physicalMachineName ?? fallbackName,
      session
    }];
  }).sort((left, right) => (
    (Date.parse(right.session.activity?.lastEventAt ?? right.session.lastActivityAt) || 0)
      - (Date.parse(left.session.activity?.lastEventAt ?? left.session.lastActivityAt) || 0)
      || left.key.localeCompare(right.key)
  ));
}

type IssueCodexThreadAction = Extract<
  CodexMachineTaskExistingResult,
  { state: 'confirmed' }
>['action'];

type IssueCodexSessionEvidence = Pick<
  CodexSession,
  'activity' | 'attention' | 'lastActivityAt' | 'status' | 'title'
>;

function presentIssueCodexSession(
  session: IssueCodexSessionEvidence | undefined,
  action: IssueCodexThreadAction,
  fallbackTitle: string
): IssueCodexThreadPresentation {
  const activity = session?.activity;
  const activityAt = activity?.lastEventAt ?? session?.lastActivityAt;
  const isOffline = offlineStatus(session?.status) || activity?.freshness === 'stale';
  const failed = activity?.conversationState === 'failed';
  const waitingForApproval = session?.attention === 'approval'
    || activity?.currentTurnState === 'waiting-for-approval';
  const waitingForInput = session?.attention === 'input'
    || activity?.currentTurnState === 'waiting-for-user';
  const waiting = waitingForApproval || waitingForInput;
  const needsAttention = action === 'resolve' || waiting || failed;
  const running = !isOffline && !needsAttention && (
    action === 'open-running'
    || session?.status === 'active'
    || activity?.conversationState === 'running'
  );
  const state: IssueCodexThreadState = isOffline
    ? 'offline'
    : needsAttention
      ? 'attention'
      : running
        ? 'running'
        : 'ready';
  const readyLabel = activity?.conversationState === 'completed' ? 'Completed' : 'Ready';
  const attentionLabel = failed
    ? 'Failed'
    : waitingForApproval
      ? 'Waiting for approval'
      : waiting
        ? 'Waiting for input'
        : 'Needs attention';
  const stateLabel: Record<IssueCodexThreadState, string> = {
    attention: attentionLabel,
    offline: activity?.freshness === 'stale' ? 'Last known' : 'Offline / unavailable',
    ready: readyLabel,
    running: 'Running'
  };
  const actionLabel = action === 'open-running'
    ? 'Open'
    : action === 'continue'
      ? 'Continue'
      : 'Resolve';

  return {
    actionLabel,
    activityAt,
    activityLabel: activity?.latestActivity
      ?? activity?.latestMilestone
      ?? (running ? 'Work in progress' : 'No recent activity reported'),
    running,
    state,
    stateLabel: stateLabel[state],
    title: session?.title.trim() || fallbackTitle
  };
}

export function presentIssueCodexInventoryThread(
  session: CodexSession,
  issueNumber: number
): IssueCodexThreadPresentation {
  const activity = session.activity;
  const needsResolution = offlineStatus(session.status)
    || activity?.freshness === 'stale'
    || session.attention === 'approval'
    || session.attention === 'input'
    || activity?.currentTurnState === 'waiting-for-approval'
    || activity?.currentTurnState === 'waiting-for-user'
    || activity?.conversationState === 'failed';
  const running = !needsResolution && (
    session.status === 'active' || activity?.conversationState === 'running'
  );
  return presentIssueCodexSession(
    session,
    needsResolution ? 'resolve' : running ? 'open-running' : 'continue',
    `Task for issue #${issueNumber}`
  );
}

export function presentIssueCodexThread(
  result: Exclude<CodexMachineTaskExistingResult, { state: 'missing' }>
): IssueCodexThreadPresentation {
  if (result.state === 'attention') {
    return {
      activityLabel: 'Activity unavailable',
      message: result.message,
      running: false,
      state: 'attention',
      stateLabel: 'Needs attention',
      title: 'Task needs attention'
    };
  }

  return presentIssueCodexSession(
    result.session,
    result.action,
    `Task for issue #${result.task.issue.number}`
  );
}

const blockedLabels: Record<CodexMachineTaskBlockedReason, string> = {
  approval_required: 'Approval required',
  codex_start_failed: 'Codex unavailable',
  connector_required: 'Connector required',
  input_required: 'Input required',
  machine_not_ready: 'Machine not ready',
  offline: 'Offline',
  send_in_progress: 'Message dispatch in progress',
  stale_connector: 'Connector state stale',
  thread_active: 'Thread already running',
  turn_changed: 'Codex turn changed',
  turn_required: 'Exact Codex turn required',
  unauthorized: 'Sign in required',
  worktree_failure: 'Workspace unavailable'
};

export function presentIssueCodexStartResult(
  result: CodexMachineTaskStartResult | undefined,
  fallbackMessage = 'Checking whether this environment can start Codex.'
): IssueCodexStartPresentation {
  if (!result) {
    return {
      canStart: false,
      message: fallbackMessage,
      state: 'checking',
      stateLabel: 'Checking…'
    };
  }
  if (result.state === 'ready') {
    return {
      canStart: true,
      message: `Ready on ${result.target.physicalMachine.name}.`,
      state: 'ready',
      stateLabel: 'Ready'
    };
  }
  if (result.state === 'blocked') {
    return {
      canStart: false,
      message: result.message,
      state: 'blocked',
      stateLabel: blockedLabels[result.reason]
    };
  }
  if (result.state === 'uncertain') {
    return {
      canStart: false,
      message: result.message,
      state: 'attention',
      stateLabel: 'Needs attention'
    };
  }
  return {
    canStart: false,
    message: 'A task appeared while readiness was being checked. Refresh this task to open it.',
    state: 'attention',
    stateLabel: 'Task found'
  };
}

export function formatIssueCodexActivity(value: string | undefined, now = new Date()) {
  if (!value) return 'Recent activity unavailable';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Recent activity unavailable';
  const elapsed = Math.max(0, now.getTime() - timestamp);
  if (elapsed < 60_000) return 'Active now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}
