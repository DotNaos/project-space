export const MACHINE_POWER_API_VERSION = 1;

export type MachinePowerRequestedState = 'on' | 'off';

export type MachinePowerEvidenceState =
  | 'online'
  | 'offline'
  | 'unknown'
  | 'unsupported'
  | 'failed';

export type MachinePowerOperationState =
  | 'accepted'
  | 'confirmed-online'
  | 'confirmed-offline'
  | 'unsupported'
  | 'failed'
  | 'uncertain';

export interface MachinePowerSelector {
  physicalMachineId?: string;
  physicalMachineName?: string;
}

export interface MachinePowerEvidence {
  checkedAt: string;
  fresh: boolean;
  firmwareVersion?: string;
  jetKvmOnline?: boolean;
  physicalPower?: boolean;
  source: 'jetkvm-mqtt';
}

export interface MachinePowerDispatchEvidence {
  attempted: boolean;
  brokerAcknowledged: boolean;
}

export interface MachinePowerStatusResult {
  apiVersion: typeof MACHINE_POWER_API_VERSION;
  evidence?: MachinePowerEvidence;
  machine: {
    id: string;
    name: string;
  };
  message: string;
  provider: {
    deviceId: string;
    kind: 'jetkvm-mqtt';
  };
  reconciliation?: {
    state: 'complete' | 'failed';
  };
  state: MachinePowerEvidenceState;
}

export interface MachinePowerRequest extends MachinePowerSelector {
  operationId: string;
  requestedState: MachinePowerRequestedState;
}

export interface MachinePowerOperationResult {
  apiVersion: typeof MACHINE_POWER_API_VERSION;
  dispatch: MachinePowerDispatchEvidence;
  evidence?: MachinePowerEvidence;
  machine: {
    id: string;
    name: string;
  };
  message: string;
  operationId: string;
  provider: {
    deviceId: string;
    kind: 'jetkvm-mqtt';
  };
  requestedState: MachinePowerRequestedState;
  state: MachinePowerOperationState;
}
