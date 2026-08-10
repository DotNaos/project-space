import { generateKeyPairSync, type KeyLike } from 'node:crypto';
import { connectorCommandGrantSigningKey } from '../connector-command-grant';
import type {
  WorkspaceCommandConnectorActor,
  WorkspaceCommandConnectorAdapter,
  WorkspaceCommandConnectorOperation,
  WorkspaceCommandConnectorRequest,
  WorkspaceCommandConnectorResult,
  WorkspaceCommandConnectorWireRequest
} from './connector-contract';
import { WorkspaceCommandConnectorExecutor } from './connector-executor';
import { createWorkspaceCommandGrant } from './connector-grant';

const localExecutors = new Map<string, {
  executor: WorkspaceCommandConnectorExecutor;
  signingKey: KeyLike;
}>();

export interface WorkspaceCommandRoutingOptions {
  nonce?: string;
  now?: number;
  signingKey?: KeyLike;
  timeoutMs?: number;
  ttlMs?: number;
}

export function registerLocalWorkspaceCommandExecutor(
  machineId: string,
  adapter: WorkspaceCommandConnectorAdapter,
  options: { signingKey?: KeyLike; verificationKey?: KeyLike } = {}
) {
  if (!machineId.trim()) throw new Error('A local workspace executor requires a machine ID.');
  if (Boolean(options.signingKey) !== Boolean(options.verificationKey))
    throw new Error('Local workspace command keys require a pair.');
  const pair = options.signingKey ? undefined : generateKeyPairSync('ed25519');
  const registration = {
    executor: new WorkspaceCommandConnectorExecutor(
      adapter, options.verificationKey ?? pair!.publicKey, machineId
    ),
    signingKey: options.signingKey ?? pair!.privateKey
  };
  localExecutors.set(machineId, registration);
  return () => {
    if (localExecutors.get(machineId) === registration) localExecutors.delete(machineId);
  };
}

export function createWorkspaceCommandWireRequest(
  operation: WorkspaceCommandConnectorOperation,
  request: WorkspaceCommandConnectorRequest,
  actor: WorkspaceCommandConnectorActor,
  key: KeyLike,
  options: WorkspaceCommandRoutingOptions = {}
): WorkspaceCommandConnectorWireRequest {
  return {
    ...request,
    grant: createWorkspaceCommandGrant(operation, request, actor, key, options)
  };
}

export function workspaceCommandSigningKey(options: WorkspaceCommandRoutingOptions) {
  const key = options.signingKey ?? connectorCommandGrantSigningKey();
  if (!key) throw new Error('Connector command signing is not configured.');
  return key;
}

export function executeLocalWorkspaceCommand(
  operation: WorkspaceCommandConnectorOperation,
  request: WorkspaceCommandConnectorRequest,
  actor: WorkspaceCommandConnectorActor,
  options: WorkspaceCommandRoutingOptions = {}
): Promise<WorkspaceCommandConnectorResult> | undefined {
  const local = localExecutors.get(request.machineId);
  if (!local) return undefined;
  return local.executor.execute(
    operation,
    createWorkspaceCommandWireRequest(
      operation, request, actor, options.signingKey ?? local.signingKey, options
    )
  );
}
