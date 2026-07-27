import type {
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeState
} from './connector-runtime-api';
import type {
  CodexDaemonConnectorResult,
  CodexDaemonEvidence
} from './codex-daemon-api';

export const MACHINE_READINESS_API_VERSION = 1 as const;

export type MachineReadinessState =
  | 'ready'
  | 'degraded'
  | 'repairable'
  | 'repairing'
  | 'repaired'
  | 'unreachable'
  | 'authorization-required'
  | 'unauthorized'
  | 'unsupported'
  | 'failed'
  | 'uncertain'
  | 'ambiguous'
  | 'manually-blocked'
  | 'rolling-back'
  | 'rolled-back'
  | 'recovery-required';

export type MachineReadinessCheckState =
  | 'ready'
  | 'outdated'
  | 'missing'
  | 'repairable'
  | 'repairing'
  | 'unreachable'
  | 'authorization-required'
  | 'unauthorized'
  | 'unsupported'
  | 'failed'
  | 'uncertain'
  | 'manually-blocked'
  | 'rolling-back'
  | 'rolled-back'
  | 'recovery-required';

export interface MachineReadinessSelector {
  connectorId?: string;
  physicalMachineId?: string;
  physicalMachineName?: string;
}

export interface MachineReadinessCheck {
  capabilities: string[];
  connectorId: string;
  connectorName: string;
  daemon?: CodexDaemonEvidence;
  online: boolean;
  runtimeSource?: string;
  runtimeVersion?: string;
  state: MachineReadinessCheckState;
  summary: string;
  updateState?: ConnectorRuntimeState;
}

export interface MachineReadinessRepairAction {
  connectorId: string;
  fromVersion?: string;
  kind: 'ensure-codex-daemon' | 'restart-codex-daemon' | 'restart-connector' | 'update-connector';
  operation: 'ensure' | 'restart' | 'update';
  releaseId?: string;
  summary: string;
  toVersion?: string;
}

export interface MachineReadinessRepairPlan {
  actions: MachineReadinessRepairAction[];
  id: string;
}

export interface MachineReadinessResult {
  apiVersion: typeof MACHINE_READINESS_API_VERSION;
  checkedAt: string;
  checks: MachineReadinessCheck[];
  machine?: {
    id: string;
    name: string;
  };
  message: string;
  nextAction: {
    command?: string;
    kind: 'contact-owner' | 'doctor' | 'doctor-fix' | 'none' | 'supported-action' | 'wait';
    message: string;
  };
  operation?: ConnectorRuntimeOperationRecord;
  plan?: MachineReadinessRepairPlan;
  ready: boolean;
  selectedConnectorId?: string;
  state: MachineReadinessState;
}

export interface MachineReadinessFixRequest extends MachineReadinessSelector {
  operationId: string;
  planId: string;
}

export interface MachineReadinessFixResult {
  apiVersion: typeof MACHINE_READINESS_API_VERSION;
  diagnosis: MachineReadinessResult;
  daemonOperation?: CodexDaemonConnectorResult;
  operationId: string;
  runtimeOperation?: ConnectorRuntimeOperationRecord;
  state:
    | 'converged'
    | 'repairing'
    | 'verification-pending'
    | 'repaired'
    | 'blocked'
    | 'failed'
    | 'rolled-back'
    | 'recovery-required';
}
