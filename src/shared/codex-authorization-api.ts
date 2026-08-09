import type { CodexMachineTaskTarget } from './codex-machine-tasks-api';

export const CODEX_AUTHORIZATION_API_VERSION = 1 as const;
export const CODEX_AUTHORIZATION_CONNECTOR_CAPABILITY =
  'codex.account.device-login.v1';

export type CodexAuthorizationAction = 'cancel' | 'start' | 'status';

export interface CodexAuthorizationSelector {
  connectorId?: string;
  environmentId?: string;
  physicalMachineId?: string;
  physicalMachineName?: string;
}

export interface CodexAuthorizationRequest extends CodexAuthorizationSelector {
  action: CodexAuthorizationAction;
  operationId: string;
}

export type CodexAuthorizationState =
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

export interface CodexAuthorizationResult {
  apiVersion: typeof CODEX_AUTHORIZATION_API_VERSION;
  deadlineAt?: string;
  message: string;
  operationId: string;
  state: CodexAuthorizationState;
  target?: CodexMachineTaskTarget;
  userCode?: string;
  verificationUrl?: string;
}

export interface CodexAuthorizationConnectorRequest {
  action: CodexAuthorizationAction;
  machineId: string;
  operationId: string;
}

export type CodexAuthorizationConnectorResult =
  | {
      state: 'ready';
    }
  | {
      deadlineAt: string;
      state: 'pending';
      userCode: string;
      verificationUrl: string;
    }
  | {
      state: 'ambiguous' | 'authorization-required' | 'cancelled' | 'expired' | 'failed';
    };
