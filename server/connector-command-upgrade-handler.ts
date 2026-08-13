import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { MachineConnectorProfile } from './machine-connection-contract';
import { legacyConnectorRetirement } from './legacy-connector-retirement';

export interface AuthenticatedConnectorIdentity {
  connectorProfile?: MachineConnectorProfile;
  machineId: string;
  userId?: string;
}

export type AuthenticateConnectorCredential = (
  token: string,
  machineId: string
) => Promise<AuthenticatedConnectorIdentity | boolean | null>;

export interface ConnectorCommandUpgradeHandlerOptions {
  authenticateConnectorCredential?: AuthenticateConnectorCredential;
  credentialRevalidationIntervalMs?: number;
  decideConnectorRuntimeMaintenance?(input: never): Promise<never>;
  recordCompatibilityUse?(ownerUserId: string | undefined, surface: string): Promise<unknown>;
}

export async function authenticateConnectorCredential(
  _actual: string,
  _machineId: string
) {
  return false;
}

interface ConnectorCommandUpgradeHandlerDependencies {
  failCommandsForMachine(machineId: string): void;
  handleConnectorResult(machineId: string, message: unknown): void;
}

function writeRetirementResponse(socket: Duplex) {
  const body = JSON.stringify(legacyConnectorRetirement);
  socket.end([
    'HTTP/1.1 410 Gone',
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ].join('\r\n'));
}

/**
 * Type-safe compatibility shim for the retired Connector command channel.
 * Canonical Workspace Runtime traffic does not use this handler.
 */
export function createConnectorCommandUpgradeHandlerCore(
  _dependencies: ConnectorCommandUpgradeHandlerDependencies,
  _options: ConnectorCommandUpgradeHandlerOptions = {}
) {
  return {
    async close() {},
    handleUpgrade(request: IncomingMessage, socket: Duplex, _head: Buffer) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/connectors/socket') return false;
      writeRetirementResponse(socket);
      return true;
    }
  };
}
