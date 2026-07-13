import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { WebSocket } from 'ws';

import type { ConnectorMachineMessage } from './connector-command-protocol';

const sockets = new Map<string, WebSocket>();
const capabilities = new Map<string, Set<string>>();
const credentialHashes = new Map<string, Buffer>();
const generations = new Map<string, number>();

export function sendConnectorJson(socket: WebSocket, payload: ConnectorMachineMessage) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function connectorSocket(machineId: string) {
  return sockets.get(machineId);
}

export function connectorHasCapability(machineId: string, capability: string) {
  return capabilities.get(machineId)?.has(capability) ?? false;
}

export function connectorSessionGeneration(machineId: string) {
  return generations.get(machineId);
}

export function isConnectorCommandChannelAvailable(machineId: string) {
  return sockets.get(machineId)?.readyState === WebSocket.OPEN;
}

export function isConnectorCommandChannelAuthenticated(
  machineId: string,
  credential: string
) {
  if (!credential || credential.length > 4_096 || !isConnectorCommandChannelAvailable(machineId)) {
    return false;
  }
  const registeredHash = credentialHashes.get(machineId);
  if (!registeredHash) {
    return false;
  }
  const presentedHash = createHash('sha256').update(credential, 'utf8').digest();
  return timingSafeEqual(registeredHash, presentedHash);
}

export function registerConnectorSession(
  machineId: string,
  socket: WebSocket,
  token: string,
  advertisedCapabilities: string[]
) {
  const generation = randomInt(1, 2 ** 48);
  sockets.set(machineId, socket);
  credentialHashes.set(machineId, createHash('sha256').update(token, 'utf8').digest());
  capabilities.set(machineId, new Set(advertisedCapabilities));
  generations.set(machineId, generation);
  return generation;
}

export function updateConnectorCapabilities(
  machineId: string,
  advertisedCapabilities: string[]
) {
  capabilities.set(machineId, new Set(advertisedCapabilities));
}

export function removeConnectorSession(machineId: string, expected?: WebSocket) {
  const current = sockets.get(machineId);
  if (!current || (expected && current !== expected)) {
    return null;
  }
  sockets.delete(machineId);
  credentialHashes.delete(machineId);
  capabilities.delete(machineId);
  generations.delete(machineId);
  return current;
}

export function disconnectConnectorSession(machineId: string) {
  const socket = removeConnectorSession(machineId);
  if (socket?.readyState === WebSocket.OPEN) {
    socket.close(1008, 'Machine credential was revoked.');
  }
  return socket;
}
