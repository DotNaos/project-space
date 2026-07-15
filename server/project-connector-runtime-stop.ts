import type { KeyLike } from 'node:crypto';

import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';
import { connectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';
import {
  ConnectorRuntimeStopDispatcher,
  type ConnectorRuntimeStopMachineMessage
} from './connector-runtime-stop-routing';
import { sendConnectorJsonAndDrain } from './project-connector-websocket-utils';

export function createProjectConnectorRuntimeStopControl(options: {
  commandVerificationKey?: KeyLike;
  machineId?: string;
  shutdown(): Promise<void> | void;
}) {
  let dispatcher: ConnectorRuntimeStopDispatcher | undefined;

  return {
    configure(registry: ConnectorProjectRegistryResult) {
      if (dispatcher) return true;
      const runtime = registry.connector.runtime;
      if (!options.commandVerificationKey || !options.machineId || !runtime ||
          runtime.channel !== 'dev' || runtime.source !== 'source') return false;
      const target = connectorRuntimeReleaseTarget(runtime.platform, runtime.architecture);
      if (!target || target === 'windows-x64') return false;
      dispatcher = new ConnectorRuntimeStopDispatcher({
        commandVerificationKey: options.commandVerificationKey,
        expectedMachineId: options.machineId,
        expectedRuntime: {
          buildId: runtime.buildId,
          channel: 'dev',
          instanceId: runtime.instanceId,
          protocolVersion: runtime.protocolVersion,
          releaseId: runtime.releaseId,
          source: 'source'
        },
        expectedTarget: target,
        shutdown: options.shutdown
      });
      return true;
    },
    get configured() {
      return Boolean(dispatcher);
    },
    async dispatch(
      message: ConnectorRuntimeStopMachineMessage,
      socket: WebSocket,
      isCurrentConnection: () => boolean
    ) {
      if (!dispatcher) {
        socket.close(1008, 'Connector runtime stop is unavailable.');
        return;
      }
      await dispatcher.dispatch(
        message.id,
        message.payload,
        async (result) => {
          if (!isCurrentConnection() || !(await sendConnectorJsonAndDrain(socket, result))) {
            throw new Error('Connector runtime stop acknowledgement was not delivered.');
          }
        },
        () => socket.close(1008, 'Connector runtime stop authorization failed.')
      );
    },
    setExpectedGeneration(generation?: number) {
      dispatcher?.setExpectedGeneration(generation);
    }
  };
}
