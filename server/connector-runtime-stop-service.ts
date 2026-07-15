import { randomUUID } from 'node:crypto';

import type { MachineRecord } from '../src/shared/project-space-api';
import { connectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';
import {
  isConnectorRuntimeStopAcceptedResult,
  type ConnectorRuntimeStopAcceptedResult,
  type ConnectorRuntimeStopIdentity,
  type ConnectorRuntimeStopPlan
} from './connector-runtime-stop-contract';

export interface ConnectorRuntimeStopBrowserRequest {
  machineId: string;
}

export interface ConnectorRuntimeStopServiceResult {
  operationId: string;
  status: 'accepted';
}

export interface ConnectorRuntimeStopMachineMembership {
  role: 'member' | 'owner';
}

export interface ConnectorRuntimeStopDirectory {
  readMachine(machineId: string): Promise<MachineRecord | null>;
  readMembership(input: {
    machineId: string;
    userId: string;
  }): Promise<ConnectorRuntimeStopMachineMembership | null>;
}

export interface ConnectorRuntimeStopServiceDispatcher {
  dispatch(input: {
    plan: ConnectorRuntimeStopPlan;
    userId: string;
  }): Promise<ConnectorRuntimeStopAcceptedResult>;
}

export type ConnectorRuntimeStopServiceErrorCode =
  | 'invalid-actor'
  | 'invalid-request'
  | 'offline'
  | 'outcome-unknown'
  | 'unauthorized'
  | 'unknown-machine'
  | 'unsupported-operation'
  | 'unsupported-platform';

export class ConnectorRuntimeStopServiceError extends Error {
  constructor(readonly code: ConnectorRuntimeStopServiceErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorRuntimeStopServiceError';
  }
}

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const machineIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseConnectorRuntimeStopBrowserRequest(
  value: unknown
): ConnectorRuntimeStopBrowserRequest {
  if (!isRecord(value) || Object.keys(value).length !== 1 ||
      typeof value.machineId !== 'string' || !machineIdPattern.test(value.machineId)) {
    throw new ConnectorRuntimeStopServiceError(
      'invalid-request', 'The connector runtime stop request is invalid.'
    );
  }
  return { machineId: value.machineId };
}

function stopIdentity(machine: MachineRecord): ConnectorRuntimeStopIdentity | undefined {
  const runtime = machine.connector.runtime;
  const profile = machine.connector.profile;
  if (!runtime || profile?.channel !== 'dev' || profile.source !== 'source') return undefined;
  return {
    buildId: runtime.buildId,
    channel: 'dev',
    instanceId: runtime.instanceId,
    protocolVersion: runtime.protocolVersion,
    releaseId: runtime.releaseId,
    source: 'source'
  };
}

export class ConnectorRuntimeStopService {
  private readonly operationId: () => string;

  constructor(private readonly options: {
    directory: ConnectorRuntimeStopDirectory;
    dispatcher: ConnectorRuntimeStopServiceDispatcher;
    operationId?(): string;
  }) {
    this.operationId = options.operationId ?? randomUUID;
  }

  async request(value: unknown, userId: string): Promise<ConnectorRuntimeStopServiceResult> {
    if (!identityPattern.test(userId)) {
      throw new ConnectorRuntimeStopServiceError(
        'invalid-actor', 'A valid authenticated user is required.'
      );
    }
    const request = parseConnectorRuntimeStopBrowserRequest(value);
    const membership = await this.options.directory.readMembership({
      machineId: request.machineId,
      userId
    });
    if (membership?.role !== 'owner') {
      throw new ConnectorRuntimeStopServiceError(
        'unauthorized', 'Only the machine owner can stop its development connector.'
      );
    }
    const machine = await this.options.directory.readMachine(request.machineId);
    if (!machine) {
      throw new ConnectorRuntimeStopServiceError(
        'unknown-machine', 'The selected machine is unavailable.'
      );
    }
    if (machine.connector.status !== 'online' && machine.connector.status !== 'local') {
      throw new ConnectorRuntimeStopServiceError('offline', 'The connector is offline.');
    }
    const expectedRuntime = stopIdentity(machine);
    if (!expectedRuntime || !(machine.connector.capabilities ?? []).includes('runtime.stop')) {
      throw new ConnectorRuntimeStopServiceError(
        'unsupported-operation',
        'Only an explicitly identified source development connector can stop itself.'
      );
    }
    const runtime = machine.connector.runtime!;
    const target = connectorRuntimeReleaseTarget(runtime.platform, runtime.architecture);
    if (!target || target === 'windows-x64') {
      throw new ConnectorRuntimeStopServiceError(
        'unsupported-platform',
        'The selected development connector platform does not support source runtime stop.'
      );
    }
    const operationId = this.operationId();
    if (!identityPattern.test(operationId)) {
      throw new ConnectorRuntimeStopServiceError(
        'outcome-unknown', 'The connector runtime stop operation could not be created.'
      );
    }
    const plan: ConnectorRuntimeStopPlan = {
      expectedRuntime,
      machineId: machine.id,
      operation: 'stop',
      operationId,
      schema: 'project-space.connector-runtime-stop/v1',
      target
    };
    const result = await this.options.dispatcher.dispatch({ plan, userId });
    if (!isConnectorRuntimeStopAcceptedResult(result) ||
        result.binding.machineId !== machine.id ||
        result.binding.operationId !== operationId ||
        result.binding.instanceId !== expectedRuntime.instanceId) {
      throw new ConnectorRuntimeStopServiceError(
        'outcome-unknown', 'The connector runtime stop acknowledgement did not match.'
      );
    }
    return { operationId, status: 'accepted' };
  }
}
