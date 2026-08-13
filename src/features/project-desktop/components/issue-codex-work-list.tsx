import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Bot, CheckCircle2, LoaderCircle, Play, TriangleAlert } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type {
  CodexMachineTaskExistingResult,
  CodexMachineTaskStartResult
} from '@/shared/codex-machine-tasks-api';
import { useIssueCodexInventory } from '../hooks/use-issue-codex-inventory';
import {
  type IssueMachineProjectRow
} from './issue-development-machine-actions';
import {
  issueCodexInventoryTasks,
  issueCodexConnectorTargets,
  presentIssueCodexStartResult,
  type IssueCodexConnectorTarget,
  type IssueCodexInventoryTarget,
  type IssueCodexStartPresentation
} from './issue-codex-work-list-model';
import {
  IssueCodexThreadRow,
  issueCodexThreadIdentity,
  issueCodexThreadPresentation,
  mergeIssueCodexThreadEntries,
  type IssueCodexThreadEntry
} from './issue-codex-thread-row';
import {
  IssueCodexStartDialog,
  type IssueCodexDialogFooterAction,
  type IssueCodexOfflineDialogGroup,
  type IssueCodexStartDialogGroup
} from './issue-codex-start-dialog';
import type { GitHubCodespaceLaunchStatus } from './github-codespace-destination';
import { useIssueCodexHostWake } from './use-issue-codex-host-wake';

export interface IssueCodexExternalTask {
  environmentLabel: string;
  key: string;
  physicalMachineName: string;
  result: CodexMachineTaskExistingResult;
}

export interface IssueCodexLookupTarget extends IssueCodexInventoryTarget {
  environmentLabel: string;
  isOnline?: boolean;
  key: string;
  physicalMachineName: string;
}

export interface IssueCodexWorkListProps {
  busyConnectorId?: string;
  busyDestinationName?: string;
  canStart: boolean;
  cloudDestination?: ReactNode;
  cloudFooterAction?: IssueCodexDialogFooterAction;
  cloudLaunchStatus?: GitHubCodespaceLaunchStatus;
  expectedBranch?: string;
  expectedCommit?: string;
  externalTasks?: IssueCodexExternalTask[];
  issueNumber: number;
  lookupTargets?: IssueCodexLookupTarget[];
  machineRows: IssueMachineProjectRow[];
  onError(message: string): void;
  onStart(row: IssueMachineProjectRow): void;
  repositoryId: string;
  renderThreadControls?(connectorId: string): ReactNode;
  startError?: string;
  startMessage?: string;
}

interface ConnectorSnapshot {
  existing?: CodexMachineTaskExistingResult;
  existingError?: string;
  startError?: string;
  startResult?: CodexMachineTaskStartResult;
}

interface ConnectorSnapshotState {
  checked: boolean;
  refreshing: boolean;
  scopeKey: string;
  values: Record<string, ConnectorSnapshot>;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function operationId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `issue-codex-readiness:${suffix}`;
}

function existingFromSnapshot(snapshot?: ConnectorSnapshot) {
  if (snapshot?.existing && snapshot.existing.state !== 'missing') return snapshot.existing;
  if (snapshot?.startResult?.state !== 'confirmed') return undefined;
  return {
    action: 'open-running' as const,
    apiVersion: snapshot.startResult.apiVersion,
    state: 'confirmed' as const,
    task: snapshot.startResult.task
  };
}

function unavailablePresentation(message: string, stateLabel: string): IssueCodexStartPresentation {
  return { canStart: false, message, state: 'unavailable', stateLabel };
}

export function groupIssueCodexTargetsByHost(targets: readonly IssueCodexConnectorTarget[]) {
  const groups = new Map<string, {
    key: string;
    name: string;
    targets: IssueCodexConnectorTarget[];
  }>();

  for (const target of targets) {
    const key = target.physicalMachineName.trim().toLowerCase();
    const group = groups.get(key) ?? {
      key,
      name: target.physicalMachineName,
      targets: []
    };
    group.targets.push(target);
    groups.set(key, group);
  }

  return [...groups.values()];
}

export function IssueCodexWorkList({
  busyConnectorId,
  busyDestinationName,
  canStart,
  cloudDestination,
  cloudFooterAction,
  cloudLaunchStatus,
  expectedBranch,
  expectedCommit,
  externalTasks = [],
  issueNumber,
  lookupTargets: supplementalLookupTargets = [],
  machineRows,
  onError,
  onStart,
  repositoryId,
  renderThreadControls,
  startError,
  startMessage
}: IssueCodexWorkListProps) {
  const cloudConnectorIds = useMemo(
    () => new Set(supplementalLookupTargets.map((target) => target.connectorId)),
    [supplementalLookupTargets]
  );
  const allTargets = useMemo(
    () => issueCodexConnectorTargets(machineRows).filter(
      (target) => !cloudConnectorIds.has(target.connectorId)
    ),
    [cloudConnectorIds, machineRows]
  );
  const targets = useMemo(
    () => allTargets.filter((target) => target.isOnline),
    [allTargets]
  );
  const offlineTargets = useMemo(
    () => allTargets.filter((target) => !target.isOnline),
    [allTargets]
  );
  const lookupTargets = useMemo(() => {
    const connectorIds = new Set(targets.map((target) => target.connectorId));
    return [
      ...targets,
      ...supplementalLookupTargets.filter(
        (target) => target.isOnline !== false && !connectorIds.has(target.connectorId)
      )
    ];
  }, [supplementalLookupTargets, targets]);
  const inventory = useIssueCodexInventory(lookupTargets);
  const inventoryTasks = useMemo(() => issueCodexInventoryTasks({
    issueNumber,
    machineNames: Object.fromEntries(inventory.state.machines.map((machine) => [
      machine.id,
      machine.name
    ])),
    repositoryId,
    sessions: inventory.state.sessions,
    targets
  }), [inventory.state.machines, inventory.state.sessions, issueNumber, repositoryId, targets]);
  const inventoryThreadConnectorIds = useMemo(
    () => new Set(inventoryTasks.map((task) => task.session.machineId)),
    [inventoryTasks]
  );
  const inventoryPendingConnectorIds = inventory.pendingConnectorIds;
  const inventoryPendingKey = [...inventoryPendingConnectorIds].sort().join('\u0000');
  const inventoryBlockedKey = [...inventory.blockedReasons].sort().flat().join('\u0000');
  const inventoryThreadKey = [...inventoryThreadConnectorIds].sort().join('\u0000');
  const scopeKey = useMemo(() => JSON.stringify([
    repositoryId,
    issueNumber,
    canStart,
    expectedBranch,
    expectedCommit,
    lookupTargets.map((target) => target.key)
  ]), [canStart, expectedBranch, expectedCommit, issueNumber, lookupTargets, repositoryId]);
  const [snapshotState, setSnapshotState] = useState<ConnectorSnapshotState>({
    checked: false,
    refreshing: true,
    scopeKey: '',
    values: {}
  });
  const [now, setNow] = useState(() => new Date());
  const [startDialogOpen, setStartDialogOpen] = useState(false);
  const offlineGroups: IssueCodexOfflineDialogGroup[] = useMemo(
    () => groupIssueCodexTargetsByHost(offlineTargets),
    [offlineTargets]
  );
  const hostWake = useIssueCodexHostWake({ groups: offlineGroups, isOpen: startDialogOpen });
  const currentSnapshotState = snapshotState.scopeKey === scopeKey
    ? snapshotState
    : { checked: false, refreshing: true, scopeKey, values: {} };
  const snapshots = currentSnapshotState.values;
  const refreshing = currentSnapshotState.refreshing;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setSnapshotState({ checked: false, refreshing: true, scopeKey, values: {} });

    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      if (!cancelled) {
        setSnapshotState((current) => current.scopeKey === scopeKey
          ? { ...current, refreshing: true }
          : { checked: false, refreshing: true, scopeKey, values: {} });
      }
      const entries = await Promise.all(lookupTargets.map(async (target) => {
        const snapshot: ConnectorSnapshot = {};
        try {
          snapshot.existing = await projectSpaceClient.getExistingCodexMachineTask({
            connectorId: target.connectorId,
            issue: issueNumber,
            repositoryId
          });
        } catch (error) {
          snapshot.existingError = errorMessage(error, 'Existing tasks could not be checked.');
          return [target.key, snapshot] as const;
        }
        if (cancelled) return [target.key, snapshot] as const;

        const startTarget = targets.find((candidate) => candidate.key === target.key);
        if (
          startTarget &&
          snapshot.existing.state === 'missing'
          && !inventoryPendingConnectorIds.has(startTarget.connectorId)
          && !inventory.blockedReasons.has(startTarget.connectorId)
          && !inventoryThreadConnectorIds.has(startTarget.connectorId)
          && canStart
          && expectedBranch
          && expectedCommit
        ) {
          try {
            snapshot.startResult = await projectSpaceClient.startCodexMachineTask({
              connectorId: startTarget.connectorId,
              dryRun: true,
              environmentId: startTarget.environmentId,
              expectedBranch,
              expectedCommit,
              issue: issueNumber,
              operationId: operationId(),
              physicalMachineId: startTarget.physicalMachineId,
              physicalMachineName: startTarget.physicalMachineId
                ? undefined
                : startTarget.physicalMachineName,
              repositoryId
            });
          } catch (error) {
            snapshot.startError = errorMessage(error, 'Readiness could not be checked.');
          }
        }
        return [target.key, snapshot] as const;
      }));
      if (!cancelled) {
        setSnapshotState({
          checked: true,
          refreshing: false,
          scopeKey,
          values: Object.fromEntries(entries)
        });
        setNow(new Date());
      }
      inFlight = false;
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    canStart,
    expectedBranch,
    expectedCommit,
    inventoryBlockedKey,
    inventoryPendingKey,
    inventoryThreadKey,
    issueNumber,
    lookupTargets,
    repositoryId,
    scopeKey,
    targets
  ]);
  const threads = useMemo<IssueCodexThreadEntry[]>(() => {
    const local = lookupTargets.flatMap((target): IssueCodexThreadEntry[] => {
      const result = existingFromSnapshot(snapshots[target.key]);
      return result ? [{
        environmentLabel: target.environmentLabel,
        isOnline: 'isOnline' in target ? target.isOnline : undefined,
        kind: 'associated',
        key: target.key,
        physicalMachineName: target.physicalMachineName,
        result
      }] : [];
    });
    const external = externalTasks.flatMap((task): IssueCodexThreadEntry[] =>
      task.result.state === 'missing'
        ? []
        : [{ ...task, kind: 'associated', result: task.result }]);
    const inventory: IssueCodexThreadEntry[] = inventoryTasks.map((task) => ({
      ...task,
      kind: 'inventory'
    }));
    const stateOrder = { running: 0, attention: 1, ready: 2, offline: 3 } as const;
    return mergeIssueCodexThreadEntries([...external, ...local], inventory).sort((left, right) => {
      const leftPresentation = issueCodexThreadPresentation(left, issueNumber);
      const rightPresentation = issueCodexThreadPresentation(right, issueNumber);
      return stateOrder[leftPresentation.state] - stateOrder[rightPresentation.state]
        || (Date.parse(rightPresentation.activityAt ?? '') || 0)
          - (Date.parse(leftPresentation.activityAt ?? '') || 0)
        || left.key.localeCompare(right.key);
    });
  }, [externalTasks, inventoryTasks, issueNumber, lookupTargets, snapshots]);
  const runningCount = threads.filter(
    (entry) => issueCodexThreadPresentation(entry, issueNumber).running
  ).length;
  const lookupErrors = lookupTargets.flatMap((target) => {
    const message = snapshots[target.key]?.existingError;
    return message ? [`${target.physicalMachineName} · ${target.environmentLabel}: ${message}`] : [];
  });
  const cloudTargetHasThread = supplementalLookupTargets.some((target) =>
    Boolean(existingFromSnapshot(snapshots[target.key]))
    || inventoryThreadConnectorIds.has(target.connectorId));
  const visibleCloudDestination = cloudTargetHasThread ? undefined : cloudDestination;
  const startTargets = canStart
    ? targets.filter((target) => (
        !existingFromSnapshot(snapshots[target.key])
        && !inventoryThreadConnectorIds.has(target.connectorId)
      ))
    : [];
  const groupedStartTargets = groupIssueCodexTargetsByHost(startTargets);

  function startPresentation(target: IssueCodexConnectorTarget) {
    const snapshot = snapshots[target.key];
    if (snapshot?.existingError) {
      return unavailablePresentation(snapshot.existingError, 'Task check failed');
    }
    if (!canStart) {
      return unavailablePresentation('Starting a new task is unavailable for this issue.', 'Not available');
    }
    if (!expectedBranch || !expectedCommit) {
      return unavailablePresentation(
        'A verified branch revision is required before a new task can start.',
        'Verified branch required'
      );
    }
    const inventoryBlocked = inventory.blockedReasons.get(target.connectorId);
    if (inventoryBlocked) {
      return unavailablePresentation(inventoryBlocked, 'Task inventory unavailable');
    }
    if (inventoryPendingConnectorIds.has(target.connectorId)) {
      return {
        canStart: false,
        message: 'Checking this environment for existing tasks before allowing another start.',
        state: 'checking' as const,
        stateLabel: 'Checking existing tasks…'
      };
    }
    if (snapshot?.startError) {
      return {
        canStart: false,
        message: snapshot.startError,
        state: 'attention' as const,
        stateLabel: 'Check failed'
      };
    }
    return presentIssueCodexStartResult(snapshot?.startResult);
  }

  const startGroups: IssueCodexStartDialogGroup[] = groupedStartTargets.map((group) => ({
    ...group,
    targets: group.targets.map((target) => ({
      presentation: startPresentation(target),
      target
    }))
  }));
  const startEnvironmentCount = startGroups.reduce(
    (count, group) => count + group.targets.length,
    0
  );
  const canOpenStartDialog = canStart && (
    startGroups.length > 0
    || offlineGroups.length > 0
    || Boolean(visibleCloudDestination)
  );
  const wakingHost = offlineGroups.find(
    (group) => hostWake.states[group.key]?.phase === 'waking'
  );
  const wakeError = offlineGroups.map((group) => ({
    group,
    state: hostWake.states[group.key]
  })).find(({ state }) => state?.phase === 'error');
  const startPendingMessage = busyConnectorId
    ? `Starting development on ${busyDestinationName ?? 'the selected machine'}…`
    : cloudLaunchStatus?.kind === 'pending'
      ? cloudLaunchStatus.message
      : wakingHost
        ? hostWake.states[wakingHost.key]?.message
        : undefined;
  const visibleStartError = cloudLaunchStatus?.kind === 'error'
    ? cloudLaunchStatus.message
    : wakeError?.state?.message ?? startError;
  const startActionPending = Boolean(startPendingMessage);
  const controlledCodespaceConnectorIds = new Set<string>();

  return (
    <div className="grid gap-4">
      <section aria-labelledby="issue-codex-threads-title">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-current/65" id="issue-codex-threads-title">
            Threads
          </h3>
          <span className="text-[10px] tabular-nums text-current/35">
            {lookupErrors.length > 0 && threads.length === 0
              ? 'Status unavailable'
              : runningCount > 0
                ? `${threads.length} · ${runningCount} running`
                : threads.length}
          </span>
        </div>
        <div className="border-b border-current/[.08]">
          {threads.map((entry) => {
            const connectorId = entry.kind === 'inventory'
              ? entry.session.machineId
              : entry.result.state === 'confirmed'
                ? entry.result.task.connector.id
                : entry.key;
            const showControls = entry.physicalMachineName === 'GitHub Codespace'
              && !controlledCodespaceConnectorIds.has(connectorId);
            if (showControls) controlledCodespaceConnectorIds.add(connectorId);
            return (
              <IssueCodexThreadRow
                controls={showControls ? renderThreadControls?.(connectorId) : undefined}
                entry={entry}
                issueNumber={issueNumber}
                key={issueCodexThreadIdentity(entry)}
                now={now}
                onError={onError}
              />
            );
          })}
          {threads.length === 0 && lookupErrors.length === 0 ? (
            <div className="flex min-h-12 items-center gap-2 border-t border-current/[.07] py-3 text-[11px] text-current/35">
              {refreshing || !currentSnapshotState.checked
                ? <LoaderCircle className="size-3.5 animate-spin" />
                : <Bot className="size-3.5" />}
              {refreshing || !currentSnapshotState.checked
                ? 'Checking existing threads…'
                : 'No threads exist for this task yet.'}
            </div>
          ) : null}
        </div>
      </section>

      {canOpenStartDialog ? (
        <section className="border-b border-current/[.08] pb-4" aria-labelledby="issue-codex-start-title">
          <div>
            <h3 className="text-xs font-semibold text-current/65" id="issue-codex-start-title">
              Runner
            </h3>
            <p className="mt-1 text-[11px] text-current/35">
              {startEnvironmentCount > 0
                ? `${startEnvironmentCount} ${startEnvironmentCount === 1 ? 'environment' : 'environments'} available`
                : visibleCloudDestination
                  ? 'GitHub Codespace available'
                  : 'No destinations online'}
            </p>
          </div>
          {startPendingMessage ? (
            <div aria-live="polite" className="mt-3 flex items-start gap-2 rounded-xl bg-blue-400/[.08] px-3 py-2.5 text-[11px] leading-5 text-blue-200">
              <LoaderCircle aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" />
              <span>{startPendingMessage}</span>
            </div>
          ) : visibleStartError ? (
            <div aria-live="polite" className="mt-3 flex items-start gap-2 rounded-xl bg-amber-400/[.09] px-3 py-2.5 text-[11px] leading-5 text-amber-200">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{visibleStartError}</span>
            </div>
          ) : startMessage ? (
            <div aria-live="polite" className="mt-3 flex items-start gap-2 px-1 text-[11px] leading-5 text-emerald-300">
              <CheckCircle2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{startMessage}</span>
            </div>
          ) : null}
          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-neutral-950/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl md:static md:border-0 md:bg-transparent md:p-0 md:pt-3 md:backdrop-blur-none">
            <Button
              className="w-full !rounded-full whitespace-nowrap"
              isDisabled={startActionPending}
              onPress={() => setStartDialogOpen(true)}
              size="lg"
              variant="primary"
            >
              {startActionPending || refreshing
                ? <LoaderCircle aria-label="Refreshing readiness" className="size-4 animate-spin" />
                : <Play className="size-4" />}
              {startActionPending ? 'Starting development…' : 'Start development'}
            </Button>
          </div>
        </section>
      ) : null}

      <IssueCodexStartDialog
        busyConnectorId={busyConnectorId}
        cloudDestination={visibleCloudDestination}
        cloudFooterAction={cloudFooterAction}
        groups={startGroups}
        hostWakeStates={hostWake.states}
        isOpen={startDialogOpen && canOpenStartDialog}
        offlineGroups={offlineGroups}
        onOpenChange={setStartDialogOpen}
        onStart={onStart}
        onWake={(group) => {
          void hostWake.wake(group).then((row) => {
            if (row) onStart(row);
          });
        }}
      />
    </div>
  );
}
