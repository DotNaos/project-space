import type { ComputeEnvironmentKind } from './compute-environment-api';

export const EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION = 1 as const;

export type ExecutionEnvironmentProviderKind = 'github_codespaces';

export type ExecutionEnvironmentLifecycleAction =
  | 'delete'
  | 'provision'
  | 'start'
  | 'status'
  | 'stop';

export type ExecutionEnvironmentLifecycleState =
  | 'deleted'
  | 'deleting'
  | 'failed'
  | 'missing'
  | 'provisioning'
  | 'running'
  | 'starting'
  | 'stopped'
  | 'stopping'
  | 'uncertain';

export type ExecutionEnvironmentLifecycleOperationState =
  | 'confirmed'
  | 'pending'
  | 'replayed'
  | 'uncertain';

export type ExecutionEnvironmentLifecycleBlockedReason =
  | 'active_execution'
  | 'agent_authorization_required'
  | 'connector_approval_required'
  | 'environment_not_found'
  | 'execution_state_uncertain'
  | 'not_authorized'
  | 'operation_conflict'
  | 'provider_reauthorization_required'
  | 'unsupported_provider';

export interface ProvisionExecutionEnvironmentRequest {
  branch: string;
  operationId: string;
  provider: ExecutionEnvironmentProviderKind;
  repositoryId: string;
  task: number;
}

export interface ExecutionEnvironmentMutationRequest {
  environmentId: string;
  operationId: string;
}

export interface StopExecutionEnvironmentRequest
extends ExecutionEnvironmentMutationRequest {
  reason?: string;
}

export interface DeleteExecutionEnvironmentRequest
extends ExecutionEnvironmentMutationRequest {}

export interface ExecutionEnvironmentLifecycleEnvironment {
  id: string;
  kind: ComputeEnvironmentKind;
  name: string;
}

export interface ExecutionEnvironmentLifecycleProvider {
  kind: ExecutionEnvironmentProviderKind;
  resource?: {
    name: string;
    url?: string;
  };
}

export interface ExecutionEnvironmentLifecycleReadiness {
  approvalUrl?: string;
  connectorId?: string;
  pendingEvidence?: string[];
  state:
    | 'authorization_required'
    | 'checking'
    | 'connector_approval_required'
    | 'offline'
    | 'ready'
    | 'unavailable';
}

export interface ExecutionEnvironmentProviderReauthorization {
  provider: 'github';
  requiredScopes: ['codespace'];
  settingsUrl?: string;
}

export interface ExecutionEnvironmentLifecycleReconciliation {
  checkedAt: string;
  state: ExecutionEnvironmentLifecycleOperationState;
}

export interface ExecutionEnvironmentLifecycleResult {
  action: ExecutionEnvironmentLifecycleAction;
  apiVersion: typeof EXECUTION_ENVIRONMENT_LIFECYCLE_API_VERSION;
  blocked?: {
    reason: ExecutionEnvironmentLifecycleBlockedReason;
  };
  environment?: ExecutionEnvironmentLifecycleEnvironment;
  lifecycle: {
    nativeState?: string;
    normalized: ExecutionEnvironmentLifecycleState;
    observedAt: string;
  };
  message: string;
  operationId: string;
  provider: ExecutionEnvironmentLifecycleProvider;
  readiness?: ExecutionEnvironmentLifecycleReadiness;
  reauthorization?: ExecutionEnvironmentProviderReauthorization;
  reconciliation: ExecutionEnvironmentLifecycleReconciliation;
}
