import { generateKeyPairSync, type KeyLike } from 'node:crypto';
import { connectorCommandGrantSigningKey } from './connector-command-grant';
import type {
  ConnectorWorktreeActionActor,
  ConnectorWorktreeActionAdapter,
  ConnectorWorktreeActionOperation,
  ConnectorWorktreeActionResult,
  ConnectorWorktreeActionTrustedRequest,
  ConnectorWorktreeActionWireRequest
} from './connector-worktree-action-contract';
import { ConnectorWorktreeActionExecutor } from './connector-worktree-action-executor';
import { createConnectorWorktreeActionGrant } from './connector-worktree-action-grant';

const locals = new Map<
  string,
  { executor: ConnectorWorktreeActionExecutor; signingKey: KeyLike }
>();
export interface WorktreeActionRequestOptions {
  grantTtlMs?: number;
  nonce?: string;
  now?: number;
  signingKey?: KeyLike;
  timeoutMs?: number;
}

export function registerLocalConnectorWorktreeActionExecutor(
  machineId: string,
  adapter: ConnectorWorktreeActionAdapter,
  options: { signingKey?: KeyLike; verificationKey?: KeyLike } = {}
) {
  if (!machineId.trim()) throw new Error('A local worktree executor requires a machine ID.');
  if (Boolean(options.signingKey) !== Boolean(options.verificationKey))
    throw new Error('Local worktree grant keys require a pair.');
  const pair = options.signingKey ? undefined : generateKeyPairSync('ed25519');
  const registration = {
    executor: new ConnectorWorktreeActionExecutor(
      adapter,
      options.verificationKey ?? pair!.publicKey,
      machineId.trim()
    ),
    signingKey: options.signingKey ?? pair!.privateKey
  };
  locals.set(machineId, registration);
  return () => {
    if (locals.get(machineId) === registration) locals.delete(machineId);
  };
}

export function createConnectorWorktreeActionWireRequest(
  operation: ConnectorWorktreeActionOperation,
  request: ConnectorWorktreeActionTrustedRequest,
  actor: ConnectorWorktreeActionActor,
  key: KeyLike,
  options: WorktreeActionRequestOptions = {}
): ConnectorWorktreeActionWireRequest {
  return {
    ...request,
    grant: createConnectorWorktreeActionGrant(operation, request, actor, key, {
      now: options.now,
      nonce: options.nonce,
      ttlMs: options.grantTtlMs
    })
  };
}

export function localConnectorWorktreeAction(
  operation: ConnectorWorktreeActionOperation,
  request: ConnectorWorktreeActionTrustedRequest,
  actor: ConnectorWorktreeActionActor,
  options: WorktreeActionRequestOptions = {}
): Promise<ConnectorWorktreeActionResult> | undefined {
  const local = locals.get(request.machineId);
  if (!local) return undefined;
  return local.executor.execute(
    operation,
    createConnectorWorktreeActionWireRequest(
      operation,
      request,
      actor,
      options.signingKey ?? local.signingKey,
      options
    )
  );
}

export function worktreeActionSigningKey(options: WorktreeActionRequestOptions) {
  const key = options.signingKey ?? connectorCommandGrantSigningKey();
  if (!key) throw new Error('Connector command signing is not configured.');
  return key;
}
