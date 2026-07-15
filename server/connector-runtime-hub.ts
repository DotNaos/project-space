import type { ConnectorHubMessage } from './connector-command-protocol';
import {
  failConnectorRuntimeCommandsForMachine,
  handleConnectorRuntimeCommandMessage
} from './connector-runtime-command-routing';
import {
  failConnectorRuntimeStopsForMachine,
  handleConnectorRuntimeStopMessage
} from './connector-runtime-stop-routing';

export function failConnectorRuntimeHubCommandsForMachine(machineId: string) {
  failConnectorRuntimeCommandsForMachine(machineId);
  failConnectorRuntimeStopsForMachine(machineId);
}

export function handleConnectorRuntimeHubMessage(
  machineId: string,
  message: ConnectorHubMessage
) {
  if (message.type === 'runtime.stop.result') {
    handleConnectorRuntimeStopMessage(machineId, message);
    return true;
  }
  if (
    message.type === 'runtime.maintenance.progress' ||
    message.type === 'runtime.maintenance.result'
  ) {
    handleConnectorRuntimeCommandMessage(machineId, message);
    return true;
  }
  return false;
}
