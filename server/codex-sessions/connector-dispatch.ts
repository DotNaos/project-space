import type { KeyLike } from 'node:crypto';

import {
  CodexSessionsGrantError,
  type CodexSessionsConnectorOperation,
  type CodexSessionsWireRequest
} from '../codex-sessions-connector-contract';
import type { ConnectorHubMessage } from '../connector-command-protocol';
import { CodexSessionsConnectorExecutor } from './connector-executor';
import { bindingForCodexSessionsRequest } from './connector-channel';
import type { CodexSessionManager } from './manager';
import { CodexOperationUncertainError } from './operation-ledger';

export class CodexSessionsConnectorDispatcher {
  private expectedGeneration?: number;
  private executor?: CodexSessionsConnectorExecutor;
  private machineId?: string;
  private readonly streams = new Map<
    string,
    { binding: ReturnType<typeof bindingForCodexSessionsRequest>; unsubscribe: () => void }
  >();

  constructor(private readonly options: {
    expectedMachineId?: string;
    manager: CodexSessionManager;
    verificationKey: KeyLike;
  }) {}

  setExpectedGeneration(generation?: number) {
    this.expectedGeneration = generation;
    if (generation === undefined) this.cancelAll();
  }

  dispatch(
    id: string,
    request: CodexSessionsWireRequest,
    send: (message: ConnectorHubMessage) => void,
    reject: () => void
  ) {
    if (this.expectedGeneration === undefined) {
      reject();
      return;
    }
    const expectedMachineId = this.options.expectedMachineId ?? this.machineId ?? request.grant.machineId;
    if (request.grant.machineId !== expectedMachineId) {
      reject();
      return;
    }
    this.machineId ??= expectedMachineId;
    const executor = this.executor ??= new CodexSessionsConnectorExecutor({
      expectedGeneration: () => this.expectedGeneration ?? -1,
      expectedMachineId,
      machineName: expectedMachineId,
      manager: this.options.manager,
      verificationKey: this.options.verificationKey
    });
    const operation = request.grant.operation;
    const binding = bindingForCodexSessionsRequest(request);

    if (operation === 'stream') {
      try {
        const unsubscribe = executor.stream(request, (event) => send({
          id,
          payload: { binding, event: { event, operation: 'stream' } },
          type: 'codex.sessions.event'
        }));
        this.streams.get(id)?.unsubscribe();
        this.streams.set(id, { binding, unsubscribe });
      } catch (error) {
        this.handleFailure(id, binding, error, send, reject);
      }
      return;
    }

    void executor.execute(operation as Exclude<CodexSessionsConnectorOperation, 'stream'>, request)
      .then((result) => send({
        id,
        payload: { binding, result },
        type: 'codex.sessions.result'
      }))
      .catch((error) => this.handleFailure(id, binding, error, send, reject));
  }

  cancel(id: string, send?: (message: ConnectorHubMessage) => void) {
    const stream = this.streams.get(id);
    if (!stream) return false;
    this.streams.delete(id);
    stream.unsubscribe();
    send?.({
      id,
      payload: { binding: stream.binding },
      type: 'codex.sessions.complete'
    });
    return true;
  }

  cancelAll() {
    for (const stream of this.streams.values()) stream.unsubscribe();
    this.streams.clear();
  }

  close() {
    this.cancelAll();
    this.executor?.close();
    this.executor = undefined;
  }

  private handleFailure(
    id: string,
    binding: ReturnType<typeof bindingForCodexSessionsRequest>,
    error: unknown,
    send: (message: ConnectorHubMessage) => void,
    reject: () => void
  ) {
    if (error instanceof CodexSessionsGrantError) {
      reject();
      return;
    }
    send({
      id,
      payload: {
        binding,
        error: {
          code: error instanceof CodexOperationUncertainError ? 'unavailable' : 'rejected'
        }
      },
      type: 'codex.sessions.error'
    });
  }
}
