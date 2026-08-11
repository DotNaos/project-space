import type { KeyLike } from 'node:crypto';

import type { CodexAuthorizationConnectorRequest } from '../../src/shared/codex-authorization-api';
import { CodexDeviceAuthorizationManager } from '../codex-authorization/connector-manager';
import {
  CodexSessionsGrantReplayProtection,
  CodexSessionsGrantError,
  isCodexSessionsWireRequest,
  verifyCodexSessionsWireRequest,
  type CodexSessionAttachRequest,
  type CodexSessionsConnectorOperation,
  type CodexSessionsWireRequest
} from '../codex-sessions-connector-contract';
import type { ConnectorHubMessage } from '../connector-command-protocol';
import { CodexSessionsConnectorExecutor } from './connector-executor';
import {
  CodexAttachChunkAssembler,
  bindingForCodexSessionsRequest,
  codexAttachMessageChunks,
  codexSessionsBindingsEqual,
  type BoundCodexAttachChunk
} from './connector-channel';
import type { CodexSessionManager } from './manager';
import type { CodexDaemonManager } from '../codex-daemon/manager';
import type { CodexDaemonConnectorRequest } from '../../src/shared/codex-daemon-api';
import {
  ConnectorRuntimeMaintenanceBusyError,
  type ConnectorRuntimeMaintenanceAdmission
} from '../connector-runtime-maintenance-safety';
import { CodexOperationUncertainError } from './operation-ledger';
import { createLocalCodexMachineTaskStarter } from '../codex-machine-tasks/connector-starter';
import {
  createConnectorCodexAttachRelay,
  type ConnectorCodexAttachRelay,
  type ConnectorCodexAttachRelayCloseCode
} from '../codex-machine-tasks/connector-attach-relay';
import {
  LocalCodexTranscriptReader,
  type LocalCodexTranscriptSource
} from './transcript-reader';
import { CodexAttachMaintenanceGate } from './attach-maintenance';

type AttachRelayFactory = typeof createConnectorCodexAttachRelay;

type ActiveAttach = {
  assembler: CodexAttachChunkAssembler;
  binding: ReturnType<typeof bindingForCodexSessionsRequest>;
  maintenance?: CodexAttachMaintenanceGate;
  nextOutputMessageId: number;
  relay?: ConnectorCodexAttachRelay;
  send(message: ConnectorHubMessage): void;
};

type CancellableOperation = Extract<
  CodexSessionsConnectorOperation,
  'browser' | 'inspect' | 'list' | 'read'
>;

const cancellableOperations = new Set<CodexSessionsConnectorOperation>([
  'browser', 'inspect', 'list', 'read'
]);

export class CodexSessionsConnectorDispatcher {
  private readonly attachReplay = new CodexSessionsGrantReplayProtection();
  private readonly authorization: Pick<
    CodexDeviceAuthorizationManager,
    'close' | 'execute'
  >;
  private readonly authorizationReplay = new CodexSessionsGrantReplayProtection();
  private readonly daemonReplay = new CodexSessionsGrantReplayProtection();
  private readonly attaches = new Map<string, ActiveAttach>();
  private readonly executions = new Map<string, AbortController>();
  private expectedGeneration?: number;
  private executor?: CodexSessionsConnectorExecutor;
  private machineId?: string;
  private readonly streams = new Map<
    string,
    { binding: ReturnType<typeof bindingForCodexSessionsRequest>; unsubscribe: () => void }
  >();

  constructor(private readonly options: {
    authorization?: Pick<CodexDeviceAuthorizationManager, 'close' | 'execute'>;
    createAttachRelay?: AttachRelayFactory;
    daemonManager?: Pick<CodexDaemonManager, 'execute'>;
    expectedMachineId?: string;
    manager: CodexSessionManager;
    maintenanceAdmission?: ConnectorRuntimeMaintenanceAdmission;
    onDaemonChanged?(): Promise<void> | void;
    transcript?: LocalCodexTranscriptSource;
    verificationKey: KeyLike;
  }) {
    this.authorization = options.authorization ?? new CodexDeviceAuthorizationManager({
      onReady: () => options.manager.close()
    });
  }

  setExpectedGeneration(generation?: number) {
    if (this.expectedGeneration !== undefined && this.expectedGeneration !== generation) {
      this.cancelAll();
    }
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
    const operation = request.grant.operation;
    const binding = bindingForCodexSessionsRequest(request);
    if (operation === 'attach') {
      this.openAttach(id, request, expectedMachineId, binding, send, reject);
      return;
    }
    if (operation === 'authorization') {
      this.authorize(id, request, expectedMachineId, binding, send, reject);
      return;
    }
    if (operation === 'daemon') {
      this.executeDaemon(id, request, expectedMachineId, binding, send, reject);
      return;
    }
    const executor = this.executor ??= new CodexSessionsConnectorExecutor({
      expectedGeneration: () => this.expectedGeneration ?? -1,
      expectedMachineId,
      machineName: expectedMachineId,
      manager: this.options.manager,
      maintenanceAdmission: this.options.maintenanceAdmission,
      startTask: createLocalCodexMachineTaskStarter(this.options.manager),
      transcript: this.options.transcript ?? new LocalCodexTranscriptReader(),
      verificationKey: this.options.verificationKey
    });
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

    const executableOperation = operation as Exclude<
      CodexSessionsConnectorOperation,
      'attach' | 'authorization' | 'daemon' | 'stream'
    >;
    if (cancellableOperations.has(executableOperation)) {
      this.dispatchCancellable(
        id,
        executableOperation as CancellableOperation,
        request,
        executor,
        binding,
        send,
        reject
      );
      return;
    }

    void executor.execute(executableOperation, request)
      .then((result) => send({
        id,
        payload: { binding, result },
        type: 'codex.sessions.result'
      }))
      .catch((error) => this.handleFailure(id, binding, error, send, reject));
  }

  cancel(id: string, send?: (message: ConnectorHubMessage) => void) {
    const attached = this.attaches.get(id);
    if (attached) {
      this.attaches.delete(id);
      attached.maintenance?.close();
      attached.relay?.close('cancelled');
      send?.({
        id,
        payload: { binding: attached.binding, code: 'cancelled' },
        type: 'codex.attach.closed'
      });
      return true;
    }
    const execution = this.executions.get(id);
    if (execution) {
      this.executions.delete(id);
      execution.abort(new Error('The Codex session command was cancelled.'));
      return true;
    }
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
    for (const attached of this.attaches.values()) {
      attached.maintenance?.close();
      attached.relay?.close('cancelled');
    }
    this.attaches.clear();
    const executions = [...this.executions.values()];
    this.executions.clear();
    for (const execution of executions) {
      execution.abort(new Error('The Codex session command was cancelled.'));
    }
    for (const stream of this.streams.values()) stream.unsubscribe();
    this.streams.clear();
  }

  acceptAttachInput(id: string, payload: BoundCodexAttachChunk) {
    const attached = this.attaches.get(id);
    if (!attached || !attached.relay ||
      !codexSessionsBindingsEqual(payload.binding, attached.binding)) return false;
    try {
      const message = attached.assembler.push(payload.chunk);
      if (message !== undefined) {
        const decision = attached.maintenance?.acceptInput(message) ?? { kind: 'forward' as const };
        if (decision.kind === 'invalid') {
          this.finishAttach(id, 'protocol_error');
          return true;
        }
        if (decision.kind === 'reject') {
          this.emitAttachOutput(id, decision.response);
          return true;
        }
        void attached.relay.send(message).catch(() => {
          this.finishAttach(id, 'unavailable');
        });
      }
      return true;
    } catch {
      this.finishAttach(id, 'protocol_error');
      return true;
    }
  }

  close() {
    this.cancelAll();
    this.executor?.close();
    this.executor = undefined;
    void this.authorization.close();
  }

  private authorize(
    id: string,
    request: CodexSessionsWireRequest,
    expectedMachineId: string,
    binding: ReturnType<typeof bindingForCodexSessionsRequest>,
    send: (message: ConnectorHubMessage) => void,
    reject: () => void
  ) {
    try {
      if (!isCodexSessionsWireRequest(request)) throw new CodexSessionsGrantError('binding-mismatch');
      verifyCodexSessionsWireRequest(request, 'authorization', this.options.verificationKey, {
        expectedGeneration: this.expectedGeneration ?? -1,
        expectedMachineId,
        replayProtection: this.authorizationReplay
      });
    } catch (error) {
      this.handleFailure(id, binding, error, send, reject);
      return;
    }
    const payload = request.payload as CodexAuthorizationConnectorRequest;
    const admission = payload.action === 'start'
      ? this.options.maintenanceAdmission?.tryBeginActivity('daemon')
      : undefined;
    if (payload.action === 'start' && this.options.maintenanceAdmission && !admission) {
      this.handleFailure(id, binding, new ConnectorRuntimeMaintenanceBusyError(), send, reject);
      return;
    }
    void this.authorization.execute(payload).then((result) => send({
      id,
      payload: { binding, result: { operation: 'authorization', result } },
      type: 'codex.sessions.result'
    })).catch((error) => this.handleFailure(id, binding, error, send, reject))
      .finally(() => admission?.release());
  }

  private executeDaemon(
    id: string,
    request: CodexSessionsWireRequest,
    expectedMachineId: string,
    binding: ReturnType<typeof bindingForCodexSessionsRequest>,
    send: (message: ConnectorHubMessage) => void,
    reject: () => void
  ) {
    try {
      if (!this.options.daemonManager || !isCodexSessionsWireRequest(request)) {
        throw new CodexSessionsGrantError('binding-mismatch');
      }
      verifyCodexSessionsWireRequest(request, 'daemon', this.options.verificationKey, {
        expectedGeneration: this.expectedGeneration ?? -1,
        expectedMachineId,
        replayProtection: this.daemonReplay
      });
    } catch (error) {
      this.handleFailure(id, binding, error, send, reject);
      return;
    }
    const payload = request.payload as CodexDaemonConnectorRequest;
    const mutates = payload.operation === 'ensure' || payload.operation === 'restart';
    const admission = mutates
      ? this.options.maintenanceAdmission?.tryBeginActivity('daemon')
      : undefined;
    if (mutates && this.options.maintenanceAdmission && !admission) {
      this.handleFailure(
        id, binding, new ConnectorRuntimeMaintenanceBusyError(), send, reject
      );
      return;
    }
    if (mutates) this.options.manager.invalidateMaintenanceState();
    void Promise.resolve()
      .then(() => this.options.daemonManager!.execute(payload.operation, payload.operationId))
      .then(async (result) => {
        if (mutates) {
          await this.options.manager.reconcileMaintenanceState().catch(() => undefined);
        }
        await this.options.onDaemonChanged?.();
        send({
          id,
          payload: { binding, result: { operation: 'daemon', result } },
          type: 'codex.sessions.result'
        });
      })
      .catch(async (error) => {
        if (mutates) {
          await this.options.manager.reconcileMaintenanceState().catch(() => undefined);
        }
        this.handleFailure(id, binding, error, send, reject);
      })
      .finally(() => admission?.release());
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

  private dispatchCancellable(
    id: string,
    operation: CancellableOperation,
    request: CodexSessionsWireRequest,
    executor: CodexSessionsConnectorExecutor,
    binding: ReturnType<typeof bindingForCodexSessionsRequest>,
    send: (message: ConnectorHubMessage) => void,
    reject: () => void
  ) {
    if (this.executions.has(id)) {
      reject();
      return;
    }
    const controller = new AbortController();
    this.executions.set(id, controller);
    void executor.execute(operation, request, controller.signal).then((result) => {
      if (!this.executions.delete(id)) return;
      send({ id, payload: { binding, result }, type: 'codex.sessions.result' });
    }).catch((error) => {
      if (!this.executions.delete(id)) return;
      this.handleFailure(id, binding, error, send, reject);
    });
  }

  private openAttach(
    id: string,
    request: CodexSessionsWireRequest,
    expectedMachineId: string,
    binding: ReturnType<typeof bindingForCodexSessionsRequest>,
    send: (message: ConnectorHubMessage) => void,
    reject: () => void
  ) {
    if (this.attaches.has(id) || this.expectedGeneration === undefined) {
      reject();
      return;
    }
    try {
      if (!isCodexSessionsWireRequest(request)) throw new CodexSessionsGrantError('binding-mismatch');
      verifyCodexSessionsWireRequest(request, 'attach', this.options.verificationKey, {
        expectedGeneration: this.expectedGeneration,
        expectedMachineId,
        replayProtection: this.attachReplay
      });
      const payload = request.payload as CodexSessionAttachRequest;
      if (payload.tunnelId !== id) throw new CodexSessionsGrantError('binding-mismatch');
    } catch (error) {
      this.handleFailure(id, binding, error, send, reject);
      return;
    }
    const attached: ActiveAttach = {
      assembler: new CodexAttachChunkAssembler(),
      binding,
      ...(this.options.maintenanceAdmission ? {
        maintenance: new CodexAttachMaintenanceGate(
          this.options.maintenanceAdmission,
          this.options.manager
        )
      } : {}),
      nextOutputMessageId: 1,
      send
    };
    this.attaches.set(id, attached);
    const generation = this.expectedGeneration;
    const factory = this.options.createAttachRelay ?? createConnectorCodexAttachRelay;
    void factory({
      onClose: (code) => this.finishAttach(id, code),
      onMessage: (message) => this.emitAttachOutput(id, message)
    }).then((relay) => {
      const current = this.attaches.get(id);
      if (!current || this.expectedGeneration !== generation) {
        relay.close('cancelled');
        return;
      }
      current.relay = relay;
      send({ id, payload: { binding }, type: 'codex.attach.ready' });
    }).catch((error) => {
      if (!this.attaches.delete(id)) return;
      this.handleFailure(id, binding, error, send, reject);
    });
  }

  private emitAttachOutput(id: string, message: string) {
    const attached = this.attaches.get(id);
    if (!attached?.relay) return;
    try {
      attached.maintenance?.observeOutput(message);
      const messageId = attached.nextOutputMessageId;
      const chunks = codexAttachMessageChunks(message, messageId);
      attached.nextOutputMessageId += 1;
      for (const chunk of chunks) {
        attached.send({
          id,
          payload: { binding: attached.binding, chunk },
          type: 'codex.attach.output'
        });
      }
    } catch {
      this.finishAttach(id, 'protocol_error');
    }
  }

  private finishAttach(id: string, code: ConnectorCodexAttachRelayCloseCode) {
    const attached = this.attaches.get(id);
    if (!attached) return;
    this.attaches.delete(id);
    attached.maintenance?.close();
    attached.relay?.close(code);
    attached.send({
      id,
      payload: { binding: attached.binding, code },
      type: 'codex.attach.closed'
    });
  }
}
