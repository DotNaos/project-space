import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import type {
  ConnectorProjectRegistryResult,
  MachineRecord
} from '../src/shared/project-space-api';
import {
  sameMachineConnectorProfile,
  type MachineConnectorProfile
} from './machine-connection-contract';
import {
  connectorMachineForRegistry,
  registerConnectorProjectRegistry
} from './connector-hub';
import {
  isConnectorHubMessage,
  parseConnectorMessage,
  type ConnectorHubMessage
} from './connector-command-protocol';
import {
  connectorSocket,
  registerConnectorSession,
  removeConnectorSession,
  sendConnectorJson,
  updateConnectorCapabilities
} from './connector-command-session-registry';
import {
  connectorRuntimeDecisionMatchesEvidence,
  connectorRuntimeMaintenanceEvidence,
  type ConnectorRuntimeMaintenanceDecision
} from './connector-runtime-registration-decision';

const connectorSocketPath = '/api/connectors/socket';
const defaultCredentialRevalidationIntervalMs = 30_000;

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
  continueConnectorRuntimeMaintenance?(input: {
    machineId: string;
    machine: MachineRecord;
    ownerUserId?: string;
    registry: ConnectorProjectRegistryResult;
  }): Promise<void>;
  prepareConnectorRuntimeMaintenance?(input: {
    machineId: string;
    machine: MachineRecord;
    ownerUserId?: string;
    registry: ConnectorProjectRegistryResult;
  }): Promise<void>;
  decideConnectorRuntimeMaintenance?(input: {
    machineId: string;
    machine: MachineRecord;
    registry: ConnectorProjectRegistryResult;
  }): Promise<ConnectorRuntimeMaintenanceDecision | undefined>;
}

interface ConnectorCommandUpgradeHandlerDependencies {
  failCommandsForMachine(machineId: string): void;
  handleConnectorResult(machineId: string, message: ConnectorHubMessage): void;
}

export async function authenticateConnectorCredential(actual: string, _machineId: string) {
  const expected = process.env.PROJECT_CONNECTOR_REGISTRATION_TOKEN ?? '';
  if (!expected || !actual) {
    return false;
  }

  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function authenticatedIdentity(
  result: AuthenticatedConnectorIdentity | boolean | null,
  machineId: string
): AuthenticatedConnectorIdentity | null {
  if (result === false || result === null) return null;
  if (result === true) return { machineId };
  return result.machineId === machineId ? result : null;
}

export function createConnectorCommandUpgradeHandlerCore(
  dependencies: ConnectorCommandUpgradeHandlerDependencies,
  options: ConnectorCommandUpgradeHandlerOptions = {}
) {
  const authenticate = options.authenticateConnectorCredential ?? authenticateConnectorCredential;
  const revalidationIntervalMs =
    options.credentialRevalidationIntervalMs ?? defaultCredentialRevalidationIntervalMs;
  if (!Number.isSafeInteger(revalidationIntervalMs) || revalidationIntervalMs <= 0) {
    throw new Error('credentialRevalidationIntervalMs must be a positive integer.');
  }
  const webSocketServer = new WebSocketServer({
    maxPayload: 2 * 1024 * 1024,
    noServer: true
  });

  webSocketServer.on('connection', (socket) => {
    let machineId = '';
    let registrationToken = '';
    let connectorProfile: MachineConnectorProfile | undefined;
    let ownerUserId: string | undefined;
    let registrationPending = false;
    let credentialRevalidationTimer: ReturnType<typeof setInterval> | undefined;
    let credentialRevalidation: Promise<AuthenticatedConnectorIdentity | null> | undefined;
    const registrationTimeout = setTimeout(() => {
      if (!machineId) {
        socket.close(1008, 'Connector registration timed out.');
      }
    }, 10_000);

    async function revalidateCredential() {
      if (!machineId || !registrationToken || socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      if (credentialRevalidation) {
        return credentialRevalidation;
      }

      const attempt = authenticate(registrationToken, machineId)
        .then((result) => authenticatedIdentity(result, machineId))
        .catch(() => null);
      credentialRevalidation = attempt;
      const identity = await attempt;
      if (credentialRevalidation === attempt) {
        credentialRevalidation = undefined;
      }
      const authenticated = Boolean(
        identity && sameMachineConnectorProfile(identity.connectorProfile, connectorProfile) &&
        identity.userId === ownerUserId
      );
      if (!authenticated && socket.readyState === WebSocket.OPEN) {
        socket.close(1008, 'Connector credential expired or was revoked.');
      }
      return authenticated;
    }

    async function decideMaintenance(
      requestedMachineId: string,
      registry: ConnectorProjectRegistryResult,
      machine: MachineRecord,
      authenticatedOwnerUserId?: string
    ) {
      const evidence = connectorRuntimeMaintenanceEvidence(registry);
      await options.prepareConnectorRuntimeMaintenance?.({
        machine,
        machineId: requestedMachineId,
        ownerUserId: authenticatedOwnerUserId,
        registry
      });
      if (!evidence) return undefined;
      const decision = await options.decideConnectorRuntimeMaintenance?.({
        machine,
        machineId: requestedMachineId,
        registry
      });
      if (!connectorRuntimeDecisionMatchesEvidence(evidence, decision)) {
        throw new Error('Connector runtime maintenance decision failed.');
      }
      return decision;
    }

    socket.on('message', async (data) => {
      const message = parseConnectorMessage(data);
      if (!isConnectorHubMessage(message)) {
        return;
      }

      if (message.type === 'connector.register') {
        if (machineId || registrationPending) {
          socket.close(1008, 'Connector already registered.');
          return;
        }
        registrationPending = true;
        const requestedMachineId = message.payload.connector.machineId;
        const identity = await authenticate(message.token, requestedMachineId)
          .then((result) => authenticatedIdentity(result, requestedMachineId))
          .catch(() => null);
        if (!identity) {
          socket.close(1008, 'Connector registration failed.');
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) {
          return;
        }

        let registeredMachine: MachineRecord;
        try {
          await registerConnectorProjectRegistry(
            message.payload,
            identity.connectorProfile
          );
          registeredMachine = connectorMachineForRegistry(
            message.payload,
            identity.connectorProfile
          );
        } catch {
          socket.close(1008, 'Connector registration failed.');
          return;
        }
        let maintenance: ConnectorRuntimeMaintenanceDecision | undefined;
        try {
          maintenance = await decideMaintenance(
            requestedMachineId,
            message.payload,
            registeredMachine,
            identity.userId
          );
        } catch {
          socket.close(1008, 'Connector runtime maintenance decision failed.');
          return;
        }
        if (socket.readyState !== WebSocket.OPEN) return;
        machineId = requestedMachineId;
        registrationToken = message.token;
        connectorProfile = identity.connectorProfile;
        ownerUserId = identity.userId;
        registrationPending = false;
        const previous = connectorSocket(machineId);
        if (previous && previous !== socket) {
          dependencies.failCommandsForMachine(machineId);
        }
        const generation = registerConnectorSession(
          machineId,
          socket,
          registrationToken,
          message.payload.connector.capabilities ?? []
        );
        if (previous && previous !== socket) {
          previous.close(1012, 'Connector replaced.');
        }
        clearTimeout(registrationTimeout);
        credentialRevalidationTimer = setInterval(() => {
          void revalidateCredential();
        }, revalidationIntervalMs);
        sendConnectorJson(socket, {
          generation,
          ...(maintenance ? { maintenance } : {}),
          type: 'connector.registered'
        });
        try {
          await options.continueConnectorRuntimeMaintenance?.({
            machine: registeredMachine,
            machineId,
            ownerUserId,
            registry: message.payload
          });
        } catch {
          socket.close(1011, 'Connector runtime maintenance scheduling failed.');
        }
        return;
      }

      if (!machineId) {
        socket.close(1008, 'Connector must register first.');
        return;
      }

      if (message.type === 'connector.registry') {
        if (message.payload.connector.machineId !== machineId) {
          socket.close(1008, 'Connector machine changed.');
          return;
        }
        if (!(await revalidateCredential()) || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        let registeredMachine: MachineRecord;
        try {
          await registerConnectorProjectRegistry(
            message.payload,
            connectorProfile
          );
          registeredMachine = connectorMachineForRegistry(message.payload, connectorProfile);
        } catch {
          socket.close(1008, 'Connector registry profile changed.');
          return;
        }
        try {
          await decideMaintenance(machineId, message.payload, registeredMachine, ownerUserId);
        } catch {
          socket.close(1008, 'Connector runtime maintenance decision failed.');
          return;
        }
        updateConnectorCapabilities(machineId, message.payload.connector.capabilities ?? []);
        try {
          await options.continueConnectorRuntimeMaintenance?.({
            machine: registeredMachine,
            machineId,
            ownerUserId,
            registry: message.payload
          });
        } catch {
          socket.close(1011, 'Connector runtime maintenance scheduling failed.');
        }
        return;
      }

      dependencies.handleConnectorResult(machineId, message);
    });

    socket.on('close', () => {
      clearTimeout(registrationTimeout);
      if (credentialRevalidationTimer) {
        clearInterval(credentialRevalidationTimer);
      }
      if (machineId && removeConnectorSession(machineId, socket)) {
        dependencies.failCommandsForMachine(machineId);
      }
    });
  });

  return {
    async close() {
      const clientClosures = [...webSocketServer.clients].map(
        (socket) =>
          new Promise<void>((resolveClient) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolveClient();
              return;
            }
            socket.once('close', () => resolveClient());
            socket.terminate();
          })
      );
      await Promise.all(clientClosures);
      await new Promise<void>((resolveClose) => {
        webSocketServer.close(() => resolveClose());
      });
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== connectorSocketPath) {
        return false;
      }

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
      return true;
    }
  };
}
