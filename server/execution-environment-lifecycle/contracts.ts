export type EnvironmentLifecycleAction = 'delete' | 'provision' | 'start' | 'stop';

export type EnvironmentLifecycleState =
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

export interface EnvironmentProviderBinding {
  branch: string;
  environmentId?: string;
  id: string;
  lifecycleState: EnvironmentLifecycleState;
  nativeState?: string;
  observedAt: string;
  providerKind: string;
  providerResourceId: string;
  repositoryFullName: string;
  task: number;
  userId: string;
}

export interface EnvironmentProviderBindingTaskKey {
  branch: string;
  providerKind: string;
  repositoryFullName: string;
  task: number;
  userId: string;
}

export interface EnvironmentLifecycleOperation {
  action: EnvironmentLifecycleAction;
  bindingId?: string;
  environmentId?: string;
  fingerprint: string;
  operationId: string;
  providerKind: string;
  scopeKey: string;
  userId: string;
}

export interface EnvironmentLifecycleStoredResult extends Record<string, unknown> {
  operationId: string;
}

export type EnvironmentLifecycleReservation =
  | { kind: 'conflict' }
  | { kind: 'fenced' }
  | { kind: 'new' }
  | { kind: 'pending' }
  | { kind: 'uncertain' }
  | { kind: 'replayed'; result: EnvironmentLifecycleStoredResult };

export type EnvironmentProviderBindingSaveResult =
  | { binding: EnvironmentProviderBinding; kind: 'saved' }
  | { kind: 'conflict' };

export interface EnvironmentLifecycleStore {
  attachBinding(input: EnvironmentLifecycleOperation & {
    bindingId: string;
    environmentId?: string;
  }): Promise<boolean>;
  complete(
    input: EnvironmentLifecycleOperation,
    result: EnvironmentLifecycleStoredResult
  ): Promise<void>;
  listBindings(userId: string): Promise<EnvironmentProviderBinding[]>;
  markRetryable(input: EnvironmentLifecycleOperation): Promise<void>;
  markUncertain(
    input: EnvironmentLifecycleOperation,
    dispatchAttempted?: boolean
  ): Promise<void>;
  readBindingByEnvironment(
    userId: string,
    environmentId: string
  ): Promise<EnvironmentProviderBinding | undefined>;
  readBindingByTask(
    input: EnvironmentProviderBindingTaskKey
  ): Promise<EnvironmentProviderBinding | undefined>;
  reserve(input: EnvironmentLifecycleOperation): Promise<EnvironmentLifecycleReservation>;
  saveBinding(input: EnvironmentProviderBinding): Promise<EnvironmentProviderBindingSaveResult>;
}
