import type {
  AccessRouteAuthorization,
  AuthorizedAccessRouteSelection,
  PrivateNetworkInventory
} from '../private-network/contracts';

export type SshControlOperation = 'status.v1';
export type SshGatewayOperationState =
  | 'reserved'
  | 'dispatching'
  | 'succeeded'
  | 'failed'
  | 'incompatible'
  | 'uncertain';

export interface SshGatewayActor {
  id: string;
  kind: 'human' | 'machine';
  ownerUserId: string;
}

export interface SshGatewayRequest {
  environmentId: string;
  operation: SshControlOperation;
  operationId: string;
}

export interface SshGatewayStatusResult {
  checkedAt: string;
  operation: 'status.v1';
  operationId: string;
  schemaVersion: 1;
  state: 'ready';
  targetIdentityRevision: string;
  type: 'result';
}

export interface SshGatewayExecutionResult {
  audit: SshGatewayAuditEvidence;
  replayed: boolean;
  result: SshGatewayStatusResult;
}

export interface SshGatewayAuditEvidence {
  actorId: string;
  actorKind: SshGatewayActor['kind'];
  capability: 'project_cli';
  completedAt?: string;
  operation: SshControlOperation;
  operationId: string;
  outcome: 'accepted' | 'failed' | 'succeeded' | 'uncertain';
  gatewayId: string;
  routeClass: 'ssh_private_network';
  routeId: string;
  targetEnvironmentId: string;
  targetIdentityRevision: string;
}

export interface SshGatewayOperationRecord {
  audit: SshGatewayAuditEvidence;
  fingerprint: string;
  result?: SshGatewayStatusResult;
  state: SshGatewayOperationState;
}

export interface SshGatewayOperationStore {
  complete(input: {
    audit: SshGatewayAuditEvidence;
    fingerprint: string;
    operationId: string;
    ownerUserId: string;
    result?: SshGatewayStatusResult;
    state: 'succeeded' | 'failed' | 'incompatible' | 'uncertain';
  }): Promise<SshGatewayOperationRecord>;
  reserve(input: {
    audit: SshGatewayAuditEvidence;
    fingerprint: string;
    operationId: string;
    ownerUserId: string;
    targetEnvironmentId: string;
  }): Promise<{ record: SshGatewayOperationRecord; replayed: boolean }>;
  markDispatchAttempted(input: {
    fingerprint: string;
    operationId: string;
    ownerUserId: string;
  }): Promise<void>;
  reconcile(input: {
    audit: SshGatewayAuditEvidence;
    fingerprint: string;
    operationId: string;
    ownerUserId: string;
    result?: SshGatewayStatusResult;
    state: 'succeeded' | 'failed';
  }): Promise<SshGatewayOperationRecord>;
}

export interface SshGatewayAuthorizationProvider {
  authorize(input: {
    actor: SshGatewayActor;
    environmentId: string;
    operation: SshControlOperation;
    phase: 'route_resolution' | 'execution';
  }): Promise<AccessRouteAuthorization>;
}

export interface SshGatewayRouteSource {
  load(ownerUserId: string): Promise<PrivateNetworkInventory>;
}

export interface SshGatewayTargetBinding {
  environmentDefinitionId: string;
  environmentId: string;
  hostId?: string;
  platformId: string;
  targetIdentityRevision: string;
}

export interface SshGatewayTargetResolver {
  resolve(ownerUserId: string, environmentId: string): Promise<SshGatewayTargetBinding>;
}

export interface SshCredentialBundle {
  certificate?: string;
  privateKey: string;
  purpose: 'project_control_gateway_v1';
}

export interface SshCredentialResolver {
  resolve(reference: string): Promise<SshCredentialBundle>;
}

export interface SshTransportResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export interface SshControlHandshake {
  cliVersion: string;
  protocolVersion: 1;
}

export interface VerifiedSshHost {
  readonly address: string;
  readonly knownHostEntry: string;
}

export interface SshControlTransport {
  handshake(input: {
    credential: SshCredentialBundle;
    route: AuthorizedAccessRouteSelection;
    timeoutMs: number;
    verifiedHost: VerifiedSshHost;
  }): Promise<SshTransportResult>;
  verifyHost(input: {
    route: AuthorizedAccessRouteSelection;
    timeoutMs: number;
  }): Promise<VerifiedSshHost>;
  execute(input: {
    credential: SshCredentialBundle;
    handshake: SshControlHandshake;
    request: SshGatewayRequest;
    route: AuthorizedAccessRouteSelection;
    timeoutMs: number;
    verifiedHost: VerifiedSshHost;
  }): Promise<SshTransportResult>;
}

export class SshGatewayError extends Error {
  constructor(
    readonly code:
      | 'authorization_denied'
      | 'route_unavailable'
      | 'operation_conflict'
      | 'operation_in_progress'
      | 'credential_unavailable'
      | 'host_key_mismatch'
      | 'cli_incompatible'
      | 'remote_failed'
      | 'timeout',
    message: string
  ) {
    super(message);
  }
}
