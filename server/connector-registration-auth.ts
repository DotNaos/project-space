import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import {
  authenticateConnectorCredential as authenticateStoredConnectorCredential,
  isDatabaseConfigured
} from './local-database-store';

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
  if (isDatabaseConfigured()) {
    return Boolean(
      await authenticateStoredConnectorCredential({ machineId, token }).catch(() => null)
    );
  }
  return hasValidLegacyConnectorRegistrationToken(token);
}
