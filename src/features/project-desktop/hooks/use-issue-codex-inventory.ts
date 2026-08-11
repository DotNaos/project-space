import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { initialCodexSessionsControllerState } from '../../codex-sessions/codex-sessions-controller';
import { useCodexSessionsInventory } from '../../codex-sessions/codex-sessions-inventory-context';
import {
  issueCodexInventoryVerification,
  type IssueCodexInventoryTarget
} from '../components/issue-codex-work-list-model';

const emptyState = initialCodexSessionsControllerState();
const emptySubscribe = () => () => undefined;
const readEmptyState = () => emptyState;

export function useIssueCodexInventory(targets: readonly IssueCodexInventoryTarget[]) {
  const inventory = useCodexSessionsInventory();
  const targetKey = targets.map((target) => (
    `${target.connectorId}\u0000${target.connectorInstanceId ?? ''}`
  )).join('\u0001');
  const machineIds = useMemo(() => [...new Set([
    ...(inventory?.machineIds ?? []),
    ...targets.map((target) => target.connectorId)
  ])].sort(), [inventory?.machineIds, targetKey]);
  const machineKey = machineIds.join('\u0000');
  const [checkedMachineKey, setCheckedMachineKey] = useState('');
  const connectorInstanceIds = useMemo(() => Object.fromEntries(
    targets.map((target) => [
      target.connectorId,
      target.connectorInstanceId
    ])
  ), [targetKey, targets]);
  const state = useSyncExternalStore(
    inventory?.controller.subscribe ?? emptySubscribe,
    inventory?.controller.getState ?? readEmptyState,
    inventory?.controller.getState ?? readEmptyState
  );

  useEffect(() => {
    const controller = inventory?.controller;
    if (!controller || machineIds.length === 0) return;
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (!active || refreshing || (typeof document !== 'undefined' && document.hidden)) return;
      refreshing = true;
      try {
        await controller.loadMachines(machineIds, connectorInstanceIds);
      } finally {
        refreshing = false;
        if (active) setCheckedMachineKey(machineKey);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [connectorInstanceIds, inventory?.controller, machineKey]);

  const checked = Boolean(inventory) && checkedMachineKey === machineKey;
  return {
    available: Boolean(inventory),
    checked,
    ...issueCodexInventoryVerification({
      checked,
      loadingMachineIds: state.loadingMachineIds,
      machines: state.machines,
      targets
    }),
    state
  };
}
