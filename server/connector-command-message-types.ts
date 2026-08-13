import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';
import type {
  ConnectorCodexHubMessage,
  ConnectorCodexMachineMessage
} from './connector-command-codex-protocol';
import type { ConnectorRuntimeMaintenanceDecision } from './connector-runtime-registration-decision';

export type ConnectorHubMessage =
  | ConnectorCodexHubMessage
  | { payload: ConnectorProjectRegistryResult; token: string; type: 'connector.register' }
  | { payload: ConnectorProjectRegistryResult; type: 'connector.registry' };

export type ConnectorMachineMessage =
  | {
      generation: number;
      maintenance?: ConnectorRuntimeMaintenanceDecision;
      type: 'connector.registered';
    }
  | ConnectorCodexMachineMessage
  | { id: string; type: 'connector.command.cancel' }
  ;
