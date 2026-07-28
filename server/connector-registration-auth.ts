import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  authenticateConnectorCredential as authenticateStoredConnectorCredential,
  getMachineConnectionDatabaseClient,
  isDatabaseConfigured
} from './local-database-store';
import type { MachineConnectorProfile } from './machine-connection-contract';

export interface ConnectorMachineTokenIdentity {
  connectorProfile?: MachineConnectorProfile;
  machineId: string;
  userId?: string;
}

function connectorRegistrationToken() {
  return process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN ?? '';
}

function hasValidLegacyConnectorRegistrationToken(actual: string) {
  const expected = connectorRegistrationToken();
  if (!expected || !actual) {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function requestConnectorToken(request: IncomingMessage) {
  const headerToken = request.headers['x-project-connector-token'];
  const authHeader = request.headers.authorization;

  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length).trim();
  }
  return '';
}

export async function authenticateConnectorMachineToken(token: string, machineId: string) {
  return Boolean(await resolveConnectorMachineTokenIdentity(token, machineId));
}

export async function resolveConnectorMachineTokenIdentity(
  token: string,
  machineId: string
): Promise<ConnectorMachineTokenIdentity | null> {
  if (isDatabaseConfigured()) {
    const identity = await authenticateStoredConnectorCredential({ machineId, token }).catch(
      () => null
    );
    if (!identity) return null;
    const client = await getMachineConnectionDatabaseClient();
    const result = await client.query<{
      connector_channel: string | null;
      connector_source: string | null;
    }>(
      `select connector_channel, connector_source
         from machine_identities
        where id = $1`,
      [machineId]
    );
    const row = result.rows[0];
    let connectorProfile: MachineConnectorProfile | undefined;
    if (row) {
      if (row.connector_channel === 'dev' && row.connector_source === 'source') {
        connectorProfile = { channel: 'dev', source: 'source' };
      } else if (row.connector_channel !== null || row.connector_source !== null) {
        throw new Error('Stored machine connector profile is invalid.');
      }
    }
    return { ...identity, connectorProfile };
  }
  return hasValidLegacyConnectorRegistrationToken(token) ? { machineId } : null;
}
