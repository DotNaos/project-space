import { useEffect, useMemo, useState } from 'react';
import { projectSpaceClient } from '../../../api/project-space-client';
import type { ConnectorOverviewResult } from '@/shared/project-space-api';
import type { MachinePowerSelector } from '@/shared/machine-power-api';
import type { IssueMachineProjectRow } from './issue-development-machine-actions';
import { canRunMachineCommand } from './issue-development-machine-actions';
import type { IssueCodexConnectorTarget } from './issue-codex-work-list-model';

export interface IssueCodexOfflineHostGroup {
  key: string;
  name: string;
  targets: IssueCodexConnectorTarget[];
}

export interface IssueCodexHostWakeState {
  message: string;
  phase: 'checking' | 'error' | 'online' | 'unavailable' | 'wakeable' | 'waking';
  selector?: MachinePowerSelector;
}

function machineSelectors(group: IssueCodexOfflineHostGroup): MachinePowerSelector[] {
  const physicalMachineIds = [...new Set(group.targets.flatMap((target) =>
    target.physicalMachineId ? [target.physicalMachineId] : []
  ))];
  return physicalMachineIds.length > 0
    ? physicalMachineIds.map((physicalMachineId) => ({ physicalMachineId }))
    : [{ physicalMachineName: group.name }];
}

function powerOperationId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `issue-codex-power:${suffix}`;
}

export function onlineRowForHost(
  group: IssueCodexOfflineHostGroup,
  overview: ConnectorOverviewResult
): IssueMachineProjectRow | undefined {
  const machines = new Map(overview.machines.map((machine) => [machine.id, machine]));

  for (const target of group.targets) {
    const machine = machines.get(target.connectorId);
    if (!canRunMachineCommand(machine)) continue;
    const option = target.row.connectorOptions?.find(
      (candidate) => candidate.connectorId === target.connectorId
    );
    return {
      ...target.row,
      connectorIds: [target.connectorId],
      connectorOptions: option ? [{
        ...option,
        canRunCommand: true,
        isOnline: true,
        machine
      }] : target.row.connectorOptions,
      machine,
      machineId: target.connectorId,
      suggestedConnectorId: target.connectorId
    };
  }

  return undefined;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForOnlineHost(group: IssueCodexOfflineHostGroup) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const overview = await projectSpaceClient.getConnectorOverview();
    const row = onlineRowForHost(group, overview);
    if (row) return row;
    await wait(2_000);
  }
  throw new Error(`${group.name} powered on, but its connector did not come online.`);
}

export function useIssueCodexHostWake({
  groups,
  isOpen
}: {
  groups: IssueCodexOfflineHostGroup[];
  isOpen: boolean;
}) {
  const [states, setStates] = useState<Record<string, IssueCodexHostWakeState>>({});
  const scope = useMemo(() => groups.map((group) => [
    group.key,
    group.name,
    group.targets.map((target) => target.connectorId)
  ]), [groups]);
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    if (!isOpen || groups.length === 0) return;
    let cancelled = false;
    setStates(Object.fromEntries(groups.map((group) => [group.key, {
      message: `Checking whether ${group.name} can be powered on remotely.`,
      phase: 'checking' as const
    }])));

    void Promise.all(groups.map(async (group) => {
      try {
        const results = await Promise.all(machineSelectors(group).map(async (selector) => {
          try {
            return {
              result: await projectSpaceClient.getMachinePowerStatus(selector),
              selector
            };
          } catch (error) {
            return { error, selector };
          }
        }));
        if (cancelled) return;
        const wakeable = results.flatMap((probe) =>
          probe.result?.state === 'offline'
            ? [{ result: probe.result, selector: probe.selector }]
            : []
        )[0];
        const first = results.find((probe) => 'result' in probe);
        const firstError = results.find((probe) => 'error' in probe);
        const state: IssueCodexHostWakeState = wakeable
          ? {
              message: wakeable.result.message,
              phase: 'wakeable',
              selector: wakeable.selector
            }
          : {
              message: first?.result?.state === 'online'
                ? `${group.name} is powered on, but none of its connectors are online.`
                : first?.result?.message
                  ?? (firstError && 'error' in firstError && firstError.error instanceof Error
                    ? firstError.error.message
                    : `Remote power is unavailable for ${group.name}.`),
              phase: 'unavailable'
            };
        setStates((current) => ({ ...current, [group.key]: state }));
      } catch (error) {
        if (cancelled) return;
        setStates((current) => ({
          ...current,
          [group.key]: {
            message: error instanceof Error
              ? error.message
              : `Remote power status is unavailable for ${group.name}.`,
            phase: 'unavailable'
          }
        }));
      }
    }));

    return () => {
      cancelled = true;
    };
  // The serialized scope deliberately avoids restarting probes for equivalent render objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, scopeKey]);

  async function wake(group: IssueCodexOfflineHostGroup) {
    const selector = states[group.key]?.selector;
    if (!selector) return undefined;
    setStates((current) => ({
      ...current,
      [group.key]: { message: `Powering on ${group.name}…`, phase: 'waking' }
    }));
    try {
      const result = await projectSpaceClient.requestMachinePower({
        ...selector,
        operationId: powerOperationId(),
        requestedState: 'on'
      });
      if (result.state === 'failed' || result.state === 'unsupported' ||
          result.state === 'confirmed-offline') {
        throw new Error(result.message);
      }
      const row = await waitForOnlineHost(group);
      setStates((current) => ({
        ...current,
        [group.key]: { message: `${group.name} is online.`, phase: 'online' }
      }));
      return row;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : `${group.name} could not be powered on.`;
      setStates((current) => ({
        ...current,
        [group.key]: { message, phase: 'error' }
      }));
      return undefined;
    }
  }

  return { states, wake };
}
