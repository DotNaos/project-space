import {
  CODEX_OPERATION_ID_PATTERN,
  type CodexSessionOperationResult,
  type CodexSessionsClient
} from '../../shared/codex-sessions-api';
import type {
  ExistingCodexTaskController,
  TopologyTaskOrigin
} from './project-topology-actions';

type Operation = 'continue' | 'interrupt';

export class TopologyCodexControllerError extends Error {
  constructor(
    readonly code: 'identity-mismatch' | 'operation-uncertain' | 'operation-rejected'
      | 'operation-id-invalid',
    message: string
  ) {
    super(message);
    this.name = 'TopologyCodexControllerError';
  }
}

export function createTopologyCodexTaskController(
  client: CodexSessionsClient,
  createOperationId: (operation: Operation, origin: TopologyTaskOrigin) => string = (
    operation
  ) => `topology:${operation}:${crypto.randomUUID()}`
): ExistingCodexTaskController<CodexSessionOperationResult> {
  const operationId = (operation: Operation, origin: TopologyTaskOrigin) => {
    const value = createOperationId(operation, origin);
    if (!CODEX_OPERATION_ID_PATTERN.test(value)) {
      throw new TopologyCodexControllerError(
        'operation-id-invalid',
        'The Codex operation identity was invalid.'
      );
    }
    return value;
  };
  return {
    async continue(origin, message) {
      const id = operationId('continue', origin);
      const result = await client.continue({
        ...origin,
        message,
        operationId: id
      });
      return validateOperationResult(result, origin, id);
    },
    async interrupt(origin, turnId) {
      const id = operationId('interrupt', origin);
      const result = await client.interrupt({
        ...origin,
        operationId: id,
        turnId
      });
      return validateOperationResult(result, origin, id, turnId);
    },
    async select(origin) {
      const result = await client.read(origin);
      if (
        result.openedReadOnly !== true
        || result.session.machineId !== origin.machineId
        || result.session.id !== origin.threadId
      ) {
        throw new TopologyCodexControllerError(
          'identity-mismatch',
          'The opened Codex task did not match the selected topology task.'
        );
      }
    }
  };
}

function validateOperationResult(
  result: CodexSessionOperationResult,
  origin: TopologyTaskOrigin,
  operationId: string,
  expectedTurnId?: string
) {
  if (
    result.threadId !== origin.threadId
    || result.operationId !== operationId
    || (expectedTurnId !== undefined && result.turnId !== expectedTurnId)
  ) {
    throw new TopologyCodexControllerError(
      'identity-mismatch',
      'The Codex operation result did not match the selected topology task.'
    );
  }
  if (result.status === 'ambiguous') {
    throw new TopologyCodexControllerError(
      'operation-uncertain',
      'Project Space could not confirm whether the Codex operation completed.'
    );
  }
  if (result.status === 'rejected') {
    throw new TopologyCodexControllerError(
      'operation-rejected',
      'The existing Codex task rejected the operation.'
    );
  }
  return result;
}
