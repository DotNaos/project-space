import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type {
  ConnectorInstallationRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { CodexSessionsPage } from './codex-sessions-page';
import type { CodexSessionsController } from './codex-sessions-controller';
import type { CodexThreadOrigin } from './codex-sessions-types';

export function CodexSessionsControllerPage({
  connectorInstallations,
  controller,
  machineIds,
  onBackFromThread,
  onOpenThread,
  onOpenProjectChatThread,
  physicalMachines,
  projects,
  selectedOrigin
}: {
  connectorInstallations?: ConnectorInstallationRecord[];
  controller: CodexSessionsController;
  machineIds: string[];
  onBackFromThread?(): void;
  onOpenThread?(origin: CodexThreadOrigin): void;
  onOpenProjectChatThread?(origin: CodexThreadOrigin): void;
  physicalMachines?: PhysicalMachineRecord[];
  projects?: ProjectSpaceRecord[];
  selectedOrigin?: CodexThreadOrigin;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );
  const machineKey = machineIds.join('\u0000');
  const selectedKey = selectedOrigin
    ? `${selectedOrigin.machineId}\u0000${selectedOrigin.threadId}`
    : '';
  const readBrowser = useCallback(
    (origin: CodexThreadOrigin) => controller.browser(origin),
    [controller]
  );

  useEffect(() => {
    void controller.loadMachines(machineIds);
  }, [controller, machineKey]);

  useEffect(() => {
    if (selectedOrigin) void controller.select(selectedOrigin);
    else controller.clearSelection();
  }, [controller, selectedKey]);

  return (
    <CodexSessionsPage
      activeTurnId={state.activeTurnId}
      connectorInstallations={connectorInstallations}
      conversations={state.conversations}
      errorMessage={state.errorMessage}
      loadingMachineIds={state.loadingMachineIds}
      machines={state.machines}
      onBackFromThread={onBackFromThread}
      onContinueThread={async (origin, message, settings) => {
        try { await controller.continue(origin, message, settings); } catch { /* Controller exposes the error in page state. */ }
      }}
      onInterruptThread={async (origin, turnId) => {
        try { await controller.interrupt(origin, turnId); } catch { /* Controller exposes the error in page state. */ }
      }}
      onOpenProjectChatThread={onOpenProjectChatThread}
      onResolveApproval={async (decision) => {
        try { await controller.resolveApproval(decision); } catch { /* Keep the decision visible for retry. */ }
      }}
      onResolveUserInput={async (decision) => {
        try { await controller.resolveUserInput(decision); } catch { /* Keep every answer visible for retry. */ }
      }}
      reading={state.reading}
      onSelectThread={(origin) => {
        if (onOpenThread) onOpenThread(origin);
        else void controller.select(origin);
      }}
      readBrowser={readBrowser}
      physicalMachines={physicalMachines}
      projects={projects}
      selectedOrigin={state.selectedOrigin}
      sessions={state.sessions}
    />
  );
}
