import { generateKeyPairSync, type KeyLike } from 'node:crypto';

import {
  connectorCommandGrantSigningKey,
  createConnectorCommandGrant
} from './connector-command-grant';
import { ConnectorDevServerCommandExecutor } from './connector-dev-server-executor';
import {
  isConnectorDevServerWireRequest,
  isConnectorDevServerListWireRequest,
  normalizeAllowedHosts,
  type ConnectorDevServerActor,
  type ConnectorDevServerAdapter,
  type ConnectorDevServerAnyTrustedRequest,
  type ConnectorDevServerAnyWireRequest,
  type ConnectorDevServerListResult,
  type ConnectorDevServerOperation,
  type ConnectorDevServerResult
} from './connector-dev-server-contract';

export interface ConnectorDevServerRequestOptions {
  grantTtlMs?: number;
  nonce?: string;
  now?: number;
  signingKey?: KeyLike;
  timeoutMs?: number;
}

const localExecutors = new Map<
  string,
  { executor: ConnectorDevServerCommandExecutor; signingKey: KeyLike }
>();

export function registerLocalConnectorDevServerExecutor(
  machineId: string,
  adapter: ConnectorDevServerAdapter,
  options: { signingKey?: KeyLike; verificationKey?: KeyLike } = {}
) {
  const normalizedMachineId = machineId.trim();
  if (!normalizedMachineId) {
    throw new Error('A local dev-server executor requires a machine ID.');
  }
  if (Boolean(options.signingKey) !== Boolean(options.verificationKey)) {
    throw new Error('Local connector grant keys must be provided as a signing/verification pair.');
  }
  const generatedKeys = options.signingKey ? undefined : generateKeyPairSync('ed25519');
  const signingKey = options.signingKey ?? generatedKeys?.privateKey;
  const verificationKey = options.verificationKey ?? generatedKeys?.publicKey;
  if (!signingKey || !verificationKey) {
    throw new Error('Could not create local connector command grant keys.');
  }
  const registration = {
    executor: new ConnectorDevServerCommandExecutor(adapter, verificationKey, normalizedMachineId),
    signingKey
  };
  localExecutors.set(normalizedMachineId, registration);
  return () => {
    if (localExecutors.get(normalizedMachineId) === registration) {
      localExecutors.delete(normalizedMachineId);
    }
  };
}

export function connectorDevServerSigningKey(options: ConnectorDevServerRequestOptions) {
  const signingKey = options.signingKey ?? connectorCommandGrantSigningKey();
  if (!signingKey) {
    throw new Error(
      'Connector command signing is not configured. Set PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY or PROJECT_CONNECTOR_COMMAND_SIGNING_PRIVATE_KEY_FILE.'
    );
  }
  return signingKey;
}

export function createConnectorDevServerWireRequest(
  operation: ConnectorDevServerOperation,
  request: ConnectorDevServerAnyTrustedRequest,
  actor: ConnectorDevServerActor,
  signingKey: KeyLike,
  options: ConnectorDevServerRequestOptions
): ConnectorDevServerAnyWireRequest {
  const normalizedRequest =
    'allowedHosts' in request
      ? {
          ...request,
          allowedHosts: normalizeAllowedHosts(request.allowedHosts)
        }
      : request;
  const wireRequest: ConnectorDevServerAnyWireRequest = {
    ...normalizedRequest,
    grant: createConnectorCommandGrant(
      { actor, operation, request: normalizedRequest },
      signingKey,
      { nonce: options.nonce, now: options.now, ttlMs: options.grantTtlMs }
    )
  };
  if (
    !isConnectorDevServerWireRequest(wireRequest) &&
    !isConnectorDevServerListWireRequest(wireRequest)
  ) {
    throw new Error('The trusted dev-server request is invalid.');
  }
  return wireRequest;
}

function settleWithin<T>(promise: Promise<T>, machineId: string, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`The connector command on ${machineId} timed out.`)),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export function executeLocalConnectorDevServerCommand(
  operation: ConnectorDevServerOperation,
  request: ConnectorDevServerAnyTrustedRequest,
  actor: ConnectorDevServerActor,
  options: ConnectorDevServerRequestOptions,
  defaultTimeoutMs: number
) {
  const local = localExecutors.get(request.machineId);
  if (!local) {
    return undefined;
  }
  const wireRequest = createConnectorDevServerWireRequest(
    operation,
    request,
    actor,
    options.signingKey ?? local.signingKey,
    options
  );
  return settleWithin(
    local.executor.execute(operation, wireRequest),
    request.machineId,
    options.timeoutMs ?? defaultTimeoutMs
  );
}
