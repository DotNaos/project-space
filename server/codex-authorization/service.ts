import type {
  CodexAuthorizationAction,
  CodexAuthorizationConnectorResult,
  CodexAuthorizationRequest,
  CodexAuthorizationResult,
  CodexAuthorizationSelector
} from '../../src/shared/codex-authorization-api';
import {
  CODEX_AUTHORIZATION_API_VERSION,
  CODEX_AUTHORIZATION_CONNECTOR_CAPABILITY
} from '../../src/shared/codex-authorization-api';
import {
  CODEX_AUTHORIZATION_REQUIRED_CONNECTOR_CAPABILITY,
  CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY,
  CODEX_RUNTIME_CONNECTOR_CAPABILITY
} from '../codex-sessions-connector-contract';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../../src/shared/project-space-api';
import type { ComputeInventorySnapshot } from '../../src/shared/compute-environment-api';
import {
  CodexConnectorNotDispatchedError,
  CodexConnectorOutcomeUnknownError,
  CodexConnectorRemoteError
} from '../codex-sessions/connector-hub';

export class CodexAuthorizationServiceError extends Error {
  constructor(
    readonly code: 'invalid-request' | 'unauthorized',
    message: string
  ) {
    super(message);
    this.name = 'CodexAuthorizationServiceError';
  }
}

export interface CodexAuthorizationServiceOptions {
  dispatch(input: {
    action: CodexAuthorizationAction;
    connectorId: string;
    generation: number;
    operationId: string;
    userId: string;
  }): Promise<CodexAuthorizationConnectorResult>;
  generationFor(connectorId: string): number | undefined;
  inventory(userId: string): Promise<{
    computeInventory?: ComputeInventorySnapshot;
    connectors: MachineRecord[];
    physicalMachines: PhysicalMachineRecord[];
  }>;
}

export function createCodexAuthorizationService(
  options: CodexAuthorizationServiceOptions
) {
  return {
    async authorize(
      actor: { userId: string },
      request: CodexAuthorizationRequest
    ): Promise<CodexAuthorizationResult> {
      if (!actor.userId) {
        throw new CodexAuthorizationServiceError(
          'unauthorized',
          'Authentication is required.'
        );
      }
      const selected = await selectTarget(actor.userId, request, options);
      if ('result' in selected) return selected.result;
      const { connector, generation, target } = selected;
      const capabilities = connector.connector.capabilities ?? [];
      if (capabilities.includes(CODEX_MACHINE_TASKS_CONNECTOR_CAPABILITY)) {
        return result(request.operationId, 'ready', 'Codex is authorized and ready.', target);
      }
      if (generation === undefined) {
        return result(
          request.operationId,
          'offline',
          'The selected connector is offline.',
          target
        );
      }
      if (
        !capabilities.includes(CODEX_RUNTIME_CONNECTOR_CAPABILITY) ||
        !capabilities.includes(CODEX_AUTHORIZATION_REQUIRED_CONNECTOR_CAPABILITY)
      ) {
        return result(
          request.operationId,
          'unsupported',
          'The selected connector does not provide a managed Codex authorization flow.',
          target
        );
      }
      if (!capabilities.includes(CODEX_AUTHORIZATION_CONNECTOR_CAPABILITY)) {
        return result(
          request.operationId,
          'unsupported',
          'Update the managed connector with Project Doctor before authorizing Codex.',
          target
        );
      }
      try {
        const remote = await options.dispatch({
          action: request.action,
          connectorId: connector.id,
          generation,
          operationId: request.operationId,
          userId: actor.userId
        });
        return presentRemote(request.operationId, remote, target);
      } catch (error) {
        if (error instanceof CodexConnectorNotDispatchedError) {
          return result(
            request.operationId,
            'offline',
            'The selected connector went offline.',
            target
          );
        }
        if (error instanceof CodexConnectorOutcomeUnknownError) {
          return result(
            request.operationId,
            'ambiguous',
            'The Codex authorization outcome could not be confirmed.',
            target
          );
        }
        if (error instanceof CodexConnectorRemoteError) {
          return result(
            request.operationId,
            error.code === 'unavailable' ? 'ambiguous' : 'failed',
            error.code === 'unavailable'
              ? 'The Codex authorization outcome could not be confirmed.'
              : 'The managed Codex authorization request was rejected.',
            target
          );
        }
        return result(
          request.operationId,
          'failed',
          'The managed Codex authorization flow failed safely.',
          target
        );
      }
    }
  };
}

async function selectTarget(
  userId: string,
  selector: CodexAuthorizationSelector & { operationId: string },
  options: CodexAuthorizationServiceOptions
): Promise<
  | { result: CodexAuthorizationResult }
  | {
      connector: MachineRecord;
      generation: number | undefined;
      target: NonNullable<CodexAuthorizationResult['target']>;
    }
> {
  const inventory = await options.inventory(userId);
  if (selector.environmentId) {
    const environment = inventory.computeInventory?.environments.find(
      (candidate) => candidate.id === selector.environmentId
    );
    if (!environment) {
      return {
        result: result(selector.operationId, 'unauthorized', 'Select one exact environment.')
      };
    }
    const associatedIds = inventory.computeInventory!.connectors
      .filter((candidate) => candidate.environmentId === environment.id)
      .map((candidate) => candidate.connectorId);
    const connectorIds = selector.connectorId
      ? associatedIds.filter((id) => id === selector.connectorId)
      : associatedIds;
    if (connectorIds.length !== 1) {
      return {
        result: result(
          selector.operationId,
          connectorIds.length > 1 ? 'ambiguous' : 'offline',
          connectorIds.length > 1
            ? 'Select one exact connector.'
            : 'The selected environment has no online connector.'
        )
      };
    }
    const connector = inventory.connectors.find((entry) => entry.id === connectorIds[0]);
    if (!connector) {
      return {
        result: result(selector.operationId, 'offline', 'The selected connector is not registered.')
      };
    }
    const generation = options.generationFor(connector.id);
    return {
      connector,
      generation,
      target: {
        connector: {
          ...(connector.environment
            ? { environment: connector.environment.label ?? connector.environment.kind }
            : {}),
          generation: generation ?? 0,
          id: connector.id,
          name: connector.name
        },
        environment: { id: environment.id, name: environment.name },
        physicalMachine: { id: environment.id, name: environment.name }
      }
    };
  }
  const physicalMatches = inventory.physicalMachines.filter((machine) => (
    selector.physicalMachineId
      ? machine.id === selector.physicalMachineId
      : selector.physicalMachineName
        ? machine.name === selector.physicalMachineName
        : false
  ));
  if (physicalMatches.length !== 1) {
    return {
      result: result(
        selector.operationId,
        physicalMatches.length > 1 ? 'ambiguous' : 'unauthorized',
        'Select one exact physical machine.'
      )
    };
  }
  const physical = physicalMatches[0]!;
  const connectorIds = selector.connectorId
    ? physical.connectorIds.filter((id) => id === selector.connectorId)
    : physical.connectorIds;
  if (connectorIds.length !== 1) {
    return {
      result: result(
        selector.operationId,
        connectorIds.length > 1 ? 'ambiguous' : 'unauthorized',
        connectorIds.length > 1
          ? 'Select one exact connector.'
          : 'Connector access is required.'
      )
    };
  }
  const connector = inventory.connectors.find((entry) => entry.id === connectorIds[0]);
  if (!connector) {
    return {
      result: result(
        selector.operationId,
        'offline',
        'The selected connector is not registered.'
      )
    };
  }
  const generation = options.generationFor(connector.id);
  const target = {
    connector: {
      ...(connector.environment
        ? { environment: connector.environment.label ?? connector.environment.kind }
        : {}),
      generation: generation ?? 0,
      id: connector.id,
      name: connector.name
    },
    physicalMachine: { id: physical.id, name: physical.name }
  };
  return { connector, generation, target };
}

function presentRemote(
  operationId: string,
  remote: CodexAuthorizationConnectorResult,
  target: NonNullable<CodexAuthorizationResult['target']>
): CodexAuthorizationResult {
  if (remote.state === 'pending') {
    return {
      apiVersion: CODEX_AUTHORIZATION_API_VERSION,
      deadlineAt: remote.deadlineAt,
      message: 'Open the verification page and enter the device code.',
      operationId,
      state: 'pending',
      target,
      userCode: remote.userCode,
      verificationUrl: remote.verificationUrl
    };
  }
  const messages: Record<Exclude<typeof remote.state, 'pending'>, string> = {
    ambiguous: 'The Codex authorization outcome could not be confirmed.',
    'authorization-required': 'Codex authorization has not been started.',
    cancelled: 'The Codex authorization attempt was cancelled.',
    expired: 'The Codex authorization attempt expired.',
    failed: 'The Codex authorization attempt failed.',
    ready: 'Codex is authorized and ready.'
  };
  return result(operationId, remote.state, messages[remote.state], target);
}

function result(
  operationId: string,
  state: CodexAuthorizationResult['state'],
  message: string,
  target?: CodexAuthorizationResult['target']
): CodexAuthorizationResult {
  return {
    apiVersion: CODEX_AUTHORIZATION_API_VERSION,
    message,
    operationId,
    state,
    ...(target ? { target } : {})
  };
}
