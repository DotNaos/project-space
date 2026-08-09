export const AGENT_RUNTIME_API_VERSION = 1 as const;

export type AgentKind = 'codex';

export type AgentRuntimeState =
  | 'ambiguous'
  | 'authorization-required'
  | 'connecting'
  | 'failed'
  | 'incompatible'
  | 'installing'
  | 'missing'
  | 'offline'
  | 'pairing-required'
  | 'ready'
  | 'remote-control-disabled'
  | 'stale_connector'
  | 'stale_evidence'
  | 'stopped'
  | 'uncertain'
  | 'unknown'
  | 'unsupported';

export type AgentAuthorizationState =
  | 'ambiguous'
  | 'authorization-required'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'offline'
  | 'pending'
  | 'ready'
  | 'unauthorized'
  | 'unsupported';

export type AgentAuthorizationSummaryState = AgentAuthorizationState | 'unknown';

export interface GetAgentStatusRequest {
  agent: AgentKind;
  environmentId: string;
}

export interface AgentRuntimeRecord {
  appServerVersion?: string;
  authorization: {
    checkedAt?: string;
    state: AgentAuthorizationSummaryState;
  };
  capabilities: string[];
  checkedAt: string;
  connector?: {
    generation?: number;
    id: string;
  };
  state: AgentRuntimeState;
  version?: string;
}

export interface AgentStatusResult {
  agent: AgentKind;
  apiVersion: typeof AGENT_RUNTIME_API_VERSION;
  environmentId: string;
  message: string;
  runtime: AgentRuntimeRecord;
}

export type AgentAuthorizationAction = 'cancel' | 'start' | 'status';

export interface AgentAuthorizationRequest extends GetAgentStatusRequest {
  operationId: string;
}

export interface AgentAuthorizationPollingGuidance {
  recommendedAfterSeconds: number;
  tool: 'get_agent_authorization';
}

export interface AgentAuthorizationResult {
  action: AgentAuthorizationAction;
  agent: AgentKind;
  apiVersion: typeof AGENT_RUNTIME_API_VERSION;
  checkedAt: string;
  deadlineAt?: string;
  environmentId: string;
  message: string;
  operationId: string;
  polling?: AgentAuthorizationPollingGuidance;
  state: AgentAuthorizationState;
  userCode?: string;
  verificationUrl?: string;
}
