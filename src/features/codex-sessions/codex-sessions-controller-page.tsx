import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ConnectorOverviewResult } from '@/shared/project-space-api';
import { CodexSessionsPage } from './codex-sessions-page';
import type { CodexSessionsController } from './codex-sessions-controller';
import type { CodexThreadOrigin } from './codex-sessions-types';

export function CodexSessionsControllerPage({
  controller,
  connectorOverview,
  isConnectorRefreshing = false,
  machineIds,
  onBackFromThread,
  onOpenThread,
  onOpenProjectChatThread,
  onManageConnector,
  selectedOrigin
}: {
  controller: CodexSessionsController;
  connectorOverview?: ConnectorOverviewResult;
  isConnectorRefreshing?: boolean;
  machineIds: string[];
  onBackFromThread?(): void;
  onOpenThread?(origin: CodexThreadOrigin): void;
  onOpenProjectChatThread?(origin: CodexThreadOrigin): void;
  onManageConnector?(machineId: string): void;
  selectedOrigin?: CodexThreadOrigin;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  const [inventoryObservedAt, setInventoryObservedAt] = useState(() => new Date());
  const machineKey = machineIds.join('\u0000');
  const connectorInstanceIds = useMemo(() => Object.fromEntries(
    (connectorOverview?.machines ?? []).map((machine) => [
      machine.id,
      machine.connector.runtime?.instanceId
    ])
  ), [connectorOverview?.machines]);
  const selectedKey = selectedOrigin
    ? `${selectedOrigin.machineId}\u0000${selectedOrigin.threadId}`
    : '';
  const readBrowser = useCallback(
    (origin: CodexThreadOrigin) => controller.browser(origin),
    [controller]
  );

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const refresh = async () => {
      if (active) setInventoryObservedAt(new Date());
      if (refreshing || (typeof document !== 'undefined' && document.hidden)) return;
      refreshing = true;
      try {
        await controller.loadMachines(machineIds, connectorInstanceIds);
      } finally {
        refreshing = false;
        if (active) setInventoryObservedAt(new Date());
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [connectorInstanceIds, controller, machineKey]);

  useEffect(() => {
    if (selectedOrigin) void controller.select(selectedOrigin);
    else controller.clearSelection();
  }, [controller, selectedKey]);

  return (
    <CodexSessionsPage
      activeTurnId={state.activeTurnId}
      conversations={state.conversations}
      connectorInstallations={connectorOverview?.machines}
      errorMessage={state.errorMessage}
      isConnectorRefreshing={isConnectorRefreshing}
      loadingMachineIds={state.loadingMachineIds}
      machines={state.machines}
      now={inventoryObservedAt}
      onBackFromThread={onBackFromThread}
      onContinueThread={async (origin, message, settings) => {
        try { await controller.continue(origin, message, settings); } catch { /* Controller exposes the error in page state. */ }
      }}
      onInterruptThread={async (origin, turnId) => {
        try { await controller.interrupt(origin, turnId); } catch { /* Controller exposes the error in page state. */ }
      }}
      onOpenProjectChatThread={onOpenProjectChatThread}
      onManageConnector={onManageConnector}
      onResolveApproval={async (decision) => {
        try { await controller.resolveApproval(decision); } catch { /* Keep the decision visible for retry. */ }
      }}
      onResolveUserInput={async (decision) => {
        try { await controller.resolveUserInput(decision); } catch { /* Keep every answer visible for retry. */ }
      }}
      reading={state.reading}
      runtimeByMachineId={state.runtimeByMachineId}
      onSelectThread={(origin) => {
        if (onOpenThread) onOpenThread(origin);
        else void controller.select(origin);
      }}
      readBrowser={readBrowser}
      selectedOrigin={state.selectedOrigin}
      sessions={state.sessions}
    />
  );
}
