import type {
  ExecutionEnvironmentLifecycleBlockedReason,
  ExecutionEnvironmentLifecycleReadiness,
  ExecutionEnvironmentLifecycleState,
  ExecutionEnvironmentProviderKind,
  ExecutionEnvironmentProviderReauthorization
} from '../../src/shared/execution-environment-lifecycle-api';
import type { EnvironmentProviderBinding } from './store';

export interface ExecutionEnvironmentProviderTarget {
  branch: string;
  repositoryFullName: string;
  task: number;
}

export interface ExecutionEnvironmentProviderObservation {
  blockedReason?: ExecutionEnvironmentLifecycleBlockedReason;
  environmentId?: string;
  lifecycleState: ExecutionEnvironmentLifecycleState;
  message: string;
  nativeState?: string;
  observedAt: string;
  outcome: 'confirmed' | 'uncertain';
  providerResourceName?: string;
  providerResourceUrl?: string;
  readiness?: ExecutionEnvironmentLifecycleReadiness;
  reauthorization?: ExecutionEnvironmentProviderReauthorization;
}

export interface ExecutionEnvironmentLifecycleProvider {
  readonly kind: ExecutionEnvironmentProviderKind;
  delete(
    binding: EnvironmentProviderBinding,
    operationId: string
  ): Promise<ExecutionEnvironmentProviderObservation>;
  provision(
    target: ExecutionEnvironmentProviderTarget,
    operationId: string
  ): Promise<ExecutionEnvironmentProviderObservation>;
  start(
    binding: EnvironmentProviderBinding,
    operationId: string
  ): Promise<ExecutionEnvironmentProviderObservation>;
  status(
    target: EnvironmentProviderBinding | ExecutionEnvironmentProviderTarget,
    correlationId: string
  ): Promise<ExecutionEnvironmentProviderObservation>;
  stop(
    binding: EnvironmentProviderBinding,
    operationId: string
  ): Promise<ExecutionEnvironmentProviderObservation>;
}
