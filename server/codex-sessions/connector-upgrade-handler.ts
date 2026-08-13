import type { ConnectorHubMessage } from '../connector-command-protocol';
import {
  createConnectorCommandUpgradeHandlerCore,
  type ConnectorCommandUpgradeHandlerOptions
} from '../connector-command-upgrade-handler';
import {
  failCodexSessionCommandsForMachine,
  handleCodexSessionsConnectorMessage
} from './connector-hub';

/**
 * Compatibility-only WebSocket bridge for legacy Codex session connectors.
 *
 * Canonical Workspace Runtime Codex traffic does not use this bridge. It remains
 * isolated so the retired Connector channel cannot pull general machine commands
 * back into the server.
 */
export function createCodexSessionsConnectorUpgradeHandler(
  options: ConnectorCommandUpgradeHandlerOptions = {}
) {
  const recordCompatibilityUse = options.recordCompatibilityUse;
  return createConnectorCommandUpgradeHandlerCore({
    failCommandsForMachine: failCodexSessionCommandsForMachine,
    handleConnectorResult(machineId: string, message: ConnectorHubMessage) {
      handleCodexSessionsConnectorMessage(machineId, message, {
        ...(recordCompatibilityUse ? { recordCompatibilityUse } : {})
      });
    }
  }, options);
}
