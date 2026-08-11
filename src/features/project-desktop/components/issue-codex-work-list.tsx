import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Bot, LoaderCircle, Monitor, Play, Server } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type {
  CodexMachineTaskExistingResult,
  CodexMachineTaskStartResult
} from '@/shared/codex-machine-tasks-api';
import { useIssueCodexInventory } from '../hooks/use-issue-codex-inventory';
import {
  physicalMachineSummary,
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
  canStart: boolean;
  cloudDestination?: ReactNode;
  expectedBranch?: string;
  expectedCommit?: string;
  externalTasks?: IssueCodexExternalTask[];
  issueNumber: number;
  lookupTargets?: IssueCodexLookupTarget[];
  machineRows: IssueMachineProjectRow[];
  onError(message: string): void;
  onStart(row: IssueMachineProjectRow): void;
  repositoryId: string;
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

function StartRow({
  busy,
  onError,
  onStart,
  presentation,
  target
}: {
  busy: boolean;
  onError(message: string): void;
  onStart(row: IssueMachineProjectRow): void;
  presentation: IssueCodexStartPresentation;
  target: IssueCodexConnectorTarget;
}) {
  const showDetails = presentation.state === 'blocked'
    || presentation.state === 'attention'
    || presentation.state === 'unavailable';
  return (
    <div
      className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-current/[.07] py-2.5 pl-5"
      data-codex-start-state={presentation.state}
      title={presentation.message}
    >
      <Server className="size-3.5 shrink-0 text-current/30" />
      <div className="min-w-36 flex-1">
        <p className="truncate text-xs font-medium text-current/65">{target.environmentLabel}</p>
        <p className={`mt-0.5 truncate text-[10px] ${presentation.state === 'ready' ? 'text-emerald-300' : presentation.state === 'blocked' || presentation.state === 'attention' ? 'text-amber-300' : 'text-current/35'}`}>
          {presentation.stateLabel}
        </p>
      </div>
      {presentation.canStart ? (
        <Button
          isDisabled={busy}
          onPress={() => onStart(target.row)}
          size="sm"
          variant="ghost"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
          {busy ? 'Starting…' : 'Start'}
        </Button>
      ) : showDetails ? (
        <Button onPress={() => onError(presentation.message)} size="sm" variant="ghost">
          Details
        </Button>
      ) : presentation.state === 'checking' ? (
        <LoaderCircle aria-label="Checking readiness" className="mr-2 size-3.5 animate-spin text-current/30" />
      ) : null}
    </div>
  );
}

export function IssueCodexWorkList({
  busyConnectorId,
  canStart,
  cloudDestination,
  expectedBranch,
  expectedCommit,
  externalTasks = [],
  issueNumber,
  lookupTargets: supplementalLookupTargets = [],
  machineRows,
  onError,
  onStart,
  repositoryId
}: IssueCodexWorkListProps) {
  const targets = useMemo(() => issueCodexConnectorTargets(machineRows), [machineRows]);
  const lookupTargets = useMemo(() => {
    const connectorIds = new Set(targets.map((target) => target.connectorId));
    return [
      ...targets,
      ...supplementalLookupTargets.filter((target) => !connectorIds.has(target.connectorId))
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
  const machineSummary = useMemo(() => physicalMachineSummary(machineRows), [machineRows]);
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
  const cloudDiscoveryBlocked = supplementalLookupTargets.some((target) =>
    !currentSnapshotState.checked
    || Boolean(snapshots[target.key]?.existingError)
    || !inventory.verifiedConnectorIds.has(target.connectorId));
  const visibleCloudDestination = cloudTargetHasThread || cloudDiscoveryBlocked ? undefined : cloudDestination;
  const startTargets = canStart
    ? targets.filter((target) => (
        !existingFromSnapshot(snapshots[target.key])
        && !inventoryThreadConnectorIds.has(target.connectorId)
      ))
    : [];
  const startGroups = [...new Map(startTargets.map((target) => [
    target.physicalMachineId ?? target.physicalMachineName,
    {
      key: target.physicalMachineId ?? target.physicalMachineName,
      name: target.physicalMachineName,
      targets: startTargets.filter((candidate) => (
        candidate.physicalMachineId ?? candidate.physicalMachineName
      ) === (target.physicalMachineId ?? target.physicalMachineName))
    }
  ])).values()];

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

  return (
    <div className="grid gap-5">
      <section aria-labelledby="issue-codex-threads-title">
        <div className="flex min-h-9 items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-current/65" id="issue-codex-threads-title">
            Threads for this task
          </h3>
          <span className="text-[10px] tabular-nums text-current/35">
            {threads.length} total · {runningCount} running
          </span>
        </div>
        <div className="border-b border-current/[.08]">
          {threads.map((entry) => (
            <IssueCodexThreadRow
              entry={entry}
              issueNumber={issueNumber}
              key={issueCodexThreadIdentity(entry)}
              now={now}
              onError={onError}
            />
          ))}
          {lookupErrors.length > 0 ? (
            <div className="flex min-h-12 items-center gap-2 border-t border-current/[.07] py-3 text-[11px] text-amber-300/80">
              <AlertTriangle className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {lookupErrors.length === 1
                  ? 'One environment could not be checked for existing threads.'
                  : `${lookupErrors.length} environments could not be checked for existing threads.`}
              </span>
              <Button
                onPress={() => onError(lookupErrors.join('\n'))}
                size="sm"
                variant="ghost"
              >
                Details
              </Button>
            </div>
          ) : null}
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

      {canStart && (startGroups.length > 0 || visibleCloudDestination) ? (
        <section aria-labelledby="issue-codex-start-title">
          <div className="flex min-h-9 items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-current/65" id="issue-codex-start-title">
              Start new thread
            </h3>
            {machineSummary.configured > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-[10px] tabular-nums text-current/30">
                {refreshing ? <LoaderCircle aria-label="Refreshing readiness" className="size-3 animate-spin" /> : null}
                {machineSummary.online} online · {machineSummary.configured} configured
              </span>
            ) : refreshing ? (
              <span className="text-[10px] text-current/30">Refreshing readiness…</span>
            ) : null}
          </div>
          <div className="border-b border-current/[.08]">
            {startGroups.map((group) => (
              <div key={group.key}>
                <div className="flex min-h-9 items-center gap-2 border-t border-current/[.08] text-[11px] font-medium text-current/55">
                  <Monitor className="size-3.5" />
                  <span className="truncate">{group.name}</span>
                  <span className="text-[10px] font-normal text-current/30">
                    {group.targets.length} {group.targets.length === 1 ? 'environment' : 'environments'}
                  </span>
                </div>
                {group.targets.map((target) => (
                  <StartRow
                    busy={busyConnectorId === target.connectorId}
                    key={target.key}
                    onError={onError}
                    onStart={onStart}
                    presentation={startPresentation(target)}
                    target={target}
                  />
                ))}
              </div>
            ))}
            {visibleCloudDestination ? (
              <div className="border-t border-current/[.08] py-1.5">
                {visibleCloudDestination}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
