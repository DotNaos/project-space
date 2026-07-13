import { useEffect, useSyncExternalStore } from 'react';
import { CodexSessionsPage } from './codex-sessions-page';
import type { CodexSessionsController } from './codex-sessions-controller';
import type { CodexThreadOrigin } from './codex-sessions-types';

export function CodexSessionsControllerPage({
  controller,
  machineIds,
  onOpenProjectChatThread,
  selectedOrigin
}: {
  controller: CodexSessionsController;
  machineIds: string[];
  onOpenProjectChatThread?(origin: CodexThreadOrigin): void;
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

  useEffect(() => {
    void controller.loadMachines(machineIds);
  }, [controller, machineKey]);

  useEffect(() => {
    if (selectedOrigin) void controller.select(selectedOrigin);
  }, [controller, selectedKey]);

  return (
    <CodexSessionsPage
      activeTurnId={state.activeTurnId}
      conversations={state.conversations}
      errorMessage={state.errorMessage}
      machines={state.machines}
      onContinueThread={async (origin, message) => {
        try { await controller.continue(origin, message); } catch { /* Controller exposes the error in page state. */ }
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
      onSelectThread={(origin) => void controller.select(origin)}
      selectedOrigin={state.selectedOrigin}
      sessions={state.sessions}
    />
  );
}
