export const clientOwnedAccessApiVersion = 1;

export type ClientOwnedAccessPhase =
  | 'local_client'
  | 'tailnet'
  | 'target'
  | 'ssh'
  | 'host_key'
  | 'codex';

export type ClientOwnedAccessFailureCode =
  | 'local_client_unavailable'
  | 'tailnet_unavailable'
  | 'target_unavailable'
  | 'ssh_unavailable'
  | 'host_key_mismatch'
  | 'authentication_failed'
  | 'codex_unavailable';

export interface ClientOwnedAccessTarget {
  address: string;
  environmentId: string;
  hostKeySha256: string;
  identityRevision: string;
  port: number;
  user: string;
}

export interface ClientOwnedAccessLaunchRequest {
  operation: 'codex' | 'ssh';
  schemaVersion: typeof clientOwnedAccessApiVersion;
  target: ClientOwnedAccessTarget;
}

export interface ClientOwnedAccessFailure {
  code: ClientOwnedAccessFailureCode;
  message: string;
  phase: ClientOwnedAccessPhase;
  retryable: boolean;
  state: 'blocked';
}
