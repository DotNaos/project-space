import { Readable } from 'node:stream';

import type { ConnectorDevServerAdapter } from './connector-dev-server-contract';
import {
  connectorRuntimeCredentialVersion,
  connectorRuntimeProtocolEnvironment,
  readConnectorRuntimeCredential,
  type ConnectorRuntimeCredential
} from './connector-runtime-credential';
import { createLocalProjectSpaceBackend } from './local-project-space-backend';
import { startProjectConnectorWebSocket } from './project-connector-websocket';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

type RuntimeBackend = ProjectSpaceBackend & Partial<ConnectorDevServerAdapter>;

interface AuthenticatedProjectConnectorRuntimeOptions {
  backend?: RuntimeBackend;
  credential: ConnectorRuntimeCredential;
  reconnectDelayMs?: number;
  registryIntervalMs?: number;
}

interface ReadAuthenticatedProjectConnectorRuntimeOptions {
  backend?: RuntimeBackend;
  environment?: NodeJS.ProcessEnv;
  input?: Pick<Readable, typeof Symbol.asyncIterator>;
  reconnectDelayMs?: number;
  registryIntervalMs?: number;
}

function startValidatedProjectConnectorRuntime({
  backend,
  credential,
  reconnectDelayMs,
  registryIntervalMs
}: AuthenticatedProjectConnectorRuntimeOptions) {
  const runtimeBackend =
    backend ?? createLocalProjectSpaceBackend({ connectorMachineId: credential.machineId });
  return startProjectConnectorWebSocket({
    backend: runtimeBackend,
    reconnectDelayMs,
    registryIntervalMs,
    runtimeCredential: credential
  });
}

export async function startAuthenticatedProjectConnectorRuntime(
  options: AuthenticatedProjectConnectorRuntimeOptions
) {
  const credential = await readConnectorRuntimeCredential(
    Readable.from([JSON.stringify(options.credential)]),
    {
      [connectorRuntimeProtocolEnvironment]: connectorRuntimeCredentialVersion
    }
  );
  if (!credential) {
    throw new Error('Connector runtime credential is missing.');
  }
  return startValidatedProjectConnectorRuntime({ ...options, credential });
}

export async function readAndStartAuthenticatedProjectConnectorRuntime({
  backend,
  environment = process.env,
  input = process.stdin,
  reconnectDelayMs,
  registryIntervalMs
}: ReadAuthenticatedProjectConnectorRuntimeOptions = {}) {
  const credential = await readConnectorRuntimeCredential(input, environment);
  if (!credential) {
    return null;
  }
  return startValidatedProjectConnectorRuntime({
    backend,
    credential,
    reconnectDelayMs,
    registryIntervalMs
  });
}
