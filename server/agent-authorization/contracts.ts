export type AgentAuthorizationOperationState =
  | 'ambiguous'
  | 'cancelled'
  | 'dispatching'
  | 'expired'
  | 'failed'
  | 'pending'
  | 'ready'
  | 'retryable';

export type AgentAuthorizationTerminalState =
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'ready';

export interface AgentAuthorizationOperation {
  agentKind: string;
  connectorGeneration?: number;
  connectorId?: string;
  environmentId: string;
  fingerprint: string;
  operationId: string;
  userId: string;
}

export interface AgentAuthorizationOperationRecord extends AgentAuthorizationOperation {
  deadlineAt?: string;
  dispatchAttempted: boolean;
  state: AgentAuthorizationOperationState;
}

export type AgentAuthorizationReservation =
  | { kind: 'conflict' }
  | { kind: 'fenced' }
  | { kind: 'in_progress'; record: AgentAuthorizationOperationRecord }
  | { kind: 'new' }
  | { kind: 'pending'; record: AgentAuthorizationOperationRecord }
  | { kind: 'ambiguous'; record: AgentAuthorizationOperationRecord }
  | { kind: 'replayed'; record: AgentAuthorizationOperationRecord };

export interface AgentAuthorizationOperationStore {
  complete(
    input: AgentAuthorizationOperation,
    state: AgentAuthorizationTerminalState
  ): Promise<void>;
  markAmbiguous(
    input: AgentAuthorizationOperation,
    dispatchAttempted?: boolean,
    deadlineAt?: string
  ): Promise<void>;
  markPending(input: AgentAuthorizationOperation, deadlineAt: string): Promise<void>;
  markRetryable(input: AgentAuthorizationOperation): Promise<void>;
  read(userId: string, operationId: string): Promise<AgentAuthorizationOperationRecord | undefined>;
  reserve(input: AgentAuthorizationOperation): Promise<AgentAuthorizationReservation>;
}
