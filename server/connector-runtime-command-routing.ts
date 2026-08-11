import { createPublicKey, randomUUID, type KeyLike } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { WebSocket } from 'ws';

import type { ConnectorRuntimeMaintenanceEvidence } from '../src/shared/connector-runtime-api';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';
import {
  ConnectorRuntimeCommandError,
  ConnectorRuntimeCommandReplayProtection,
  createConnectorRuntimeCommandWireRequest,
  isConnectorRuntimeCommandWireRequest,
  type ConnectorRuntimeCommandOperation,
  type ConnectorRuntimeCommandPlan,
  type ConnectorRuntimeCommandWireRequest
} from './connector-runtime-command-contract';
import {
  ConnectorRuntimeCommandExecutor,
  ConnectorRuntimeCommandExecutorError,
  type ConnectorRuntimeCommandStage,
  type ConnectorRuntimeCommandStageEvent
} from './connector-runtime-command-executor';
import type { ConnectorRuntimeReleaseTarget } from './connector-runtime-maintenance-contract';
import type { ConnectorRuntimeMaintenanceSafetyCheck } from './connector-runtime-maintenance-safety';
export {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from './connector-runtime-maintenance-safety';
import {
  connectorRuntimeDecisionMatchesEvidence,
  ConnectorRuntimeDecisionWriter,
  type ConnectorRuntimeMaintenanceDecision
} from './connector-runtime-registration-decision';
import { ConnectorRuntimeSupervisorOutcomeReader } from './connector-runtime-supervisor-outcome';
export { isConnectorRuntimeMetadata } from './connector-runtime-metadata';
import { connectorDevServerSigningKey } from './connector-dev-server-routing';
import {
  connectorHasCapability,
  connectorSessionGeneration,
  connectorSocket
} from './connector-command-session-registry';

export interface ConnectorRuntimeCommandBinding {
  generation: number;
  machineId: string;
  operation: ConnectorRuntimeCommandOperation;
  operationId: string;
  planSha256: string;
  target: ConnectorRuntimeReleaseTarget;
}

export interface ConnectorRuntimeCommandProgress {
  binding: ConnectorRuntimeCommandBinding;
  stage: ConnectorRuntimeCommandStage;
}

export type ConnectorRuntimeCommandRejectionCode =
  | 'busy'
  | 'codex-state-uncertain'
  | 'codex-turn-active'
  | 'codex-turn-starting'
  | 'codex-waiting-approval'
  | 'codex-waiting-input'
  | 'control-conflict'
  | 'download-failed'
  | 'integrity-failed'
  | 'machine-mutation'
  | 'maintenance-in-progress'
  | 'unavailable';

export type ConnectorRuntimeCommandResult =
  | { binding: ConnectorRuntimeCommandBinding; status: 'accepted' }
  | {
      binding: ConnectorRuntimeCommandBinding;
      code: ConnectorRuntimeCommandRejectionCode;
      status: 'rejected';
    };

export type ConnectorRuntimeMachineCommandMessage = {
  id: string;
  payload: ConnectorRuntimeCommandWireRequest;
  type: 'runtime.maintenance';
};

export type ConnectorRuntimeHubCommandMessage =
  | {
      id: string;
      payload: ConnectorRuntimeCommandProgress;
      type: 'runtime.maintenance.progress';
    }
  | {
      id: string;
      payload: ConnectorRuntimeCommandResult;
      type: 'runtime.maintenance.result';
    };

const commandTimeoutMs = 10 * 60_000;
const managedRuntimeCapabilities = new Set(['runtime.restart', 'runtime.update']);
const runtimeCapabilities = new Set([...managedRuntimeCapabilities, 'runtime.stop']);
const progressStages = new Set<ConnectorRuntimeCommandStage>([
  'accepted',
  'staging',
  'validating',
  'verifying'
]);
const rejectionCodes = new Set<ConnectorRuntimeCommandRejectionCode>([
  'busy',
  'codex-state-uncertain',
  'codex-turn-active',
  'codex-turn-starting',
  'codex-waiting-approval',
  'codex-waiting-input',
  'control-conflict',
  'download-failed',
  'integrity-failed',
  'machine-mutation',
  'maintenance-in-progress',
  'unavailable'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function bounded(value: unknown, maximum = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function isTarget(value: unknown): value is ConnectorRuntimeReleaseTarget {
  return value === 'darwin-arm64' || value === 'linux-x64' || value === 'windows-x64';
}

export function connectorRuntimeCommandBinding(
  request: ConnectorRuntimeCommandWireRequest
): ConnectorRuntimeCommandBinding {
  return {
    generation: request.grant.generation,
    machineId: request.grant.machineId,
    operation: request.grant.operation,
    operationId: request.grant.operationId,
    planSha256: request.grant.planSha256,
    target: request.grant.target
  };
}

function isBinding(value: unknown): value is ConnectorRuntimeCommandBinding {
  return isRecord(value) && hasExactKeys(value, [
    'generation', 'machineId', 'operation', 'operationId', 'planSha256', 'target'
  ]) && typeof value.generation === 'number' && Number.isSafeInteger(value.generation) &&
    value.generation > 0 && bounded(value.machineId) &&
    (value.operation === 'restart' || value.operation === 'update') && bounded(value.operationId) &&
    typeof value.planSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.planSha256) &&
    isTarget(value.target);
}

export function isConnectorRuntimeCommandProgress(
  value: unknown
): value is ConnectorRuntimeCommandProgress {
  return isRecord(value) && hasExactKeys(value, ['binding', 'stage']) &&
    isBinding(value.binding) && progressStages.has(value.stage as ConnectorRuntimeCommandStage);
}

export function isConnectorRuntimeCommandResult(
  value: unknown
): value is ConnectorRuntimeCommandResult {
  if (!isRecord(value) || !isBinding(value.binding)) return false;
  return value.status === 'accepted'
    ? hasExactKeys(value, ['binding', 'status'])
    : value.status === 'rejected' && hasExactKeys(value, ['binding', 'code', 'status']) &&
        rejectionCodes.has(value.code as ConnectorRuntimeCommandRejectionCode);
}

export function isConnectorRuntimeMachineCommandMessage(
  value: unknown
): value is ConnectorRuntimeMachineCommandMessage {
  return isRecord(value) && hasExactKeys(value, ['id', 'payload', 'type']) &&
    value.type === 'runtime.maintenance' && bounded(value.id, 128) &&
    isConnectorRuntimeCommandWireRequest(value.payload);
}

export function isConnectorRuntimeHubCommandMessage(
  value: unknown
): value is ConnectorRuntimeHubCommandMessage {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'payload', 'type']) ||
      !bounded(value.id, 128)) return false;
  return value.type === 'runtime.maintenance.progress'
    ? isConnectorRuntimeCommandProgress(value.payload)
    : value.type === 'runtime.maintenance.result' &&
        isConnectorRuntimeCommandResult(value.payload);
}

function bindingsEqual(left: ConnectorRuntimeCommandBinding, right: ConnectorRuntimeCommandBinding) {
  return left.generation === right.generation && left.machineId === right.machineId &&
    left.operation === right.operation && left.operationId === right.operationId &&
    left.planSha256 === right.planSha256 && left.target === right.target;
}

type PendingRuntimeCommand = {
  binding: ConnectorRuntimeCommandBinding;
  machineId: string;
  onProgress?: (progress: ConnectorRuntimeCommandProgress) => void;
  reject(error: Error): void;
  resolve(result: ConnectorRuntimeCommandResult): void;
  timeout: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingRuntimeCommand>();

export class ConnectorRuntimeCommandUnavailableError extends Error {
  readonly code = 'unavailable';

  constructor() {
    super('The selected connector does not provide managed runtime maintenance.');
    this.name = 'ConnectorRuntimeCommandUnavailableError';
  }
}

export class ConnectorRuntimeCommandOutcomeUnknownError extends Error {
  readonly code = 'outcome-unknown';

  constructor() {
    super('The connector runtime command outcome is unknown.');
    this.name = 'ConnectorRuntimeCommandOutcomeUnknownError';
  }
}

export class ConnectorRuntimeCommandRejectedError extends Error {
  constructor(readonly code: ConnectorRuntimeCommandRejectionCode) {
    super('The connector rejected the runtime maintenance operation.');
    this.name = 'ConnectorRuntimeCommandRejectedError';
  }
}

export function requestConnectorRuntimeCommand(
  plan: ConnectorRuntimeCommandPlan,
  userId: string,
  options: {
    grantTtlMs?: number;
    nonce?: string;
    now?: number;
    onProgress?(progress: ConnectorRuntimeCommandProgress): void;
    signingKey?: KeyLike;
    timeoutMs?: number;
  } = {}
) {
  const socket = connectorSocket(plan.machineId);
  const generation = connectorSessionGeneration(plan.machineId);
  if (!socket || socket.readyState !== WebSocket.OPEN || generation === undefined ||
      !connectorHasCapability(plan.machineId, `runtime.${plan.operation}`)) {
    throw new ConnectorRuntimeCommandUnavailableError();
  }
  const request = createConnectorRuntimeCommandWireRequest(
    { generation, plan, userId },
    connectorDevServerSigningKey({ signingKey: options.signingKey }),
    { nonce: options.nonce, now: options.now, ttlMs: options.grantTtlMs }
  );
  const id = randomUUID();
  const binding = connectorRuntimeCommandBinding(request);
  const promise = new Promise<ConnectorRuntimeCommandResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new ConnectorRuntimeCommandOutcomeUnknownError());
    }, options.timeoutMs ?? commandTimeoutMs);
    pending.set(id, {
      binding,
      machineId: plan.machineId,
      onProgress: options.onProgress,
      reject,
      resolve,
      timeout
    });
  });
  try {
    socket.send(JSON.stringify({ id, payload: request, type: 'runtime.maintenance' }));
  } catch {
    const current = pending.get(id);
    if (current) clearTimeout(current.timeout);
    pending.delete(id);
    throw new ConnectorRuntimeCommandUnavailableError();
  }
  return promise;
}

export async function requestConnectorRuntimeMaintenance(input: {
  onProgress(stage: ConnectorRuntimeCommandStage): void;
  plan: ConnectorRuntimeCommandPlan;
  userId: string;
}): Promise<void> {
  const result = await requestConnectorRuntimeCommand(input.plan, input.userId, {
    onProgress: (progress) => input.onProgress(progress.stage)
  });
  if (result.status === 'rejected') {
    throw new ConnectorRuntimeCommandRejectedError(result.code);
  }
}

export function handleConnectorRuntimeCommandMessage(
  machineId: string,
  message: ConnectorRuntimeHubCommandMessage
) {
  const current = pending.get(message.id);
  if (!current) return true;
  if (current.machineId !== machineId || !bindingsEqual(current.binding, message.payload.binding)) {
    finishPending(message.id, new ConnectorRuntimeCommandOutcomeUnknownError());
    return true;
  }
  if (message.type === 'runtime.maintenance.progress') {
    try {
      current.onProgress?.(message.payload);
    } catch {
      // Observer failures do not change the authenticated connector operation.
    }
    clearTimeout(current.timeout);
    current.timeout = setTimeout(
      () => finishPending(message.id, new ConnectorRuntimeCommandOutcomeUnknownError()),
      commandTimeoutMs
    );
    return true;
  }
  finishPending(message.id, undefined, message.payload);
  return true;
}

export function failConnectorRuntimeCommandsForMachine(machineId: string) {
  for (const [id, current] of pending) {
    if (current.machineId === machineId) {
      finishPending(id, new ConnectorRuntimeCommandOutcomeUnknownError());
    }
  }
}

function finishPending(id: string, error?: Error, result?: ConnectorRuntimeCommandResult) {
  const current = pending.get(id);
  if (!current) return;
  pending.delete(id);
  clearTimeout(current.timeout);
  if (error) current.reject(error);
  else if (result) current.resolve(result);
}

interface ConnectorRuntimeDispatcherOptions {
  commandVerificationKey: KeyLike;
  controlFilePath: string;
  decisionFilePath: string;
  expectedMachineId: string;
  expectedTarget: ConnectorRuntimeReleaseTarget;
  fetchArtifact?: (url: string, init: RequestInit) => Promise<Response>;
  maintenanceSafety: ConnectorRuntimeMaintenanceSafetyCheck;
  maintenanceSelection?: {
    commit(operationId: string): Promise<unknown>;
    restore(operationId: string): Promise<unknown>;
  };
  outcomeFilePath?: string;
  outcomePollIntervalMs?: number;
  outcomeTimeoutMs?: number;
  now?(): number;
  releaseVerificationKey: Buffer | KeyLike | string;
  shutdown(): Promise<void> | void;
  shutdownDelayMs?: number;
  stagingDirectory: string;
}

export class ConnectorRuntimeCommandDispatcher {
  private expectedGeneration?: number;
  private readonly decisionWriter: ConnectorRuntimeDecisionWriter;
  private readonly outcomeReader?: ConnectorRuntimeSupervisorOutcomeReader;
  private readonly replay = new ConnectorRuntimeCommandReplayProtection();

  constructor(private readonly options: ConnectorRuntimeDispatcherOptions) {
    this.decisionWriter = new ConnectorRuntimeDecisionWriter(options.decisionFilePath);
    this.outcomeReader = options.outcomeFilePath
      ? new ConnectorRuntimeSupervisorOutcomeReader(options.outcomeFilePath)
      : undefined;
  }

  setExpectedGeneration(generation?: number) {
    this.expectedGeneration = generation;
  }

  async acceptRegistration(
    evidence: ConnectorRuntimeMaintenanceEvidence | undefined,
    decision: ConnectorRuntimeMaintenanceDecision | undefined
  ) {
    if (!connectorRuntimeDecisionMatchesEvidence(evidence, decision)) {
      if (!evidence && !decision) return;
      throw new Error('The connector runtime decision does not match registration evidence.');
    }
    const transactional = evidence?.state === 'pending-health-check' ? decision : undefined;
    if (transactional && !this.options.maintenanceSelection) {
      throw new Error('The managed Codex maintenance selection is unavailable.');
    }
    if (transactional?.action === 'commit') {
      if (!this.outcomeReader) {
        throw new Error('The connector runtime supervisor outcome is unavailable.');
      }
      await this.decisionWriter.accept(evidence, decision);
      await this.outcomeReader.waitForCommit(transactional.operationId, {
        ...(this.options.outcomePollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: this.options.outcomePollIntervalMs }),
        ...(this.options.outcomeTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.options.outcomeTimeoutMs })
      });
      await this.options.maintenanceSelection!.commit(transactional.operationId);
      await this.outcomeReader.acknowledgeCommit(transactional.operationId);
      return;
    }
    if (transactional?.action === 'rollback') {
      await this.options.maintenanceSelection!.restore(transactional.operationId);
    }
    await this.decisionWriter.accept(evidence, decision);
  }

  dispatch(
    id: string,
    request: ConnectorRuntimeCommandWireRequest,
    send: (message: ConnectorRuntimeHubCommandMessage) => void,
    rejectAuthorization: () => void
  ) {
    const generation = this.expectedGeneration;
    if (generation === undefined) {
      rejectAuthorization();
      return;
    }
    const binding = connectorRuntimeCommandBinding(request);
    const emit = (event: ConnectorRuntimeCommandStageEvent) => send({
      id,
      payload: { binding, stage: event.stage },
      type: 'runtime.maintenance.progress'
    });
    const executor = new ConnectorRuntimeCommandExecutor({
      ...this.options,
      emitStage: emit,
      expectedGeneration: generation,
      replayProtection: this.replay,
      shutdown: async () => {
        send({ id, payload: { binding, status: 'accepted' }, type: 'runtime.maintenance.result' });
        await new Promise((resolve) => setTimeout(resolve, this.options.shutdownDelayMs ?? 50));
        await this.options.shutdown();
      }
    });
    void executor.execute(request).catch((error) => {
      if (error instanceof ConnectorRuntimeCommandError) {
        rejectAuthorization();
        return;
      }
      const code = error instanceof ConnectorRuntimeCommandExecutorError &&
        rejectionCodes.has(error.code as ConnectorRuntimeCommandRejectionCode)
        ? error.code as ConnectorRuntimeCommandRejectionCode
        : 'unavailable';
      send({ id, payload: { binding, code, status: 'rejected' }, type: 'runtime.maintenance.result' });
    });
  }
}

function configuredTarget(): ConnectorRuntimeReleaseTarget | undefined {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  return undefined;
}

function releasePublicKey(environment: NodeJS.ProcessEnv) {
  if (environment.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY?.trim()) {
    return environment.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY.trim();
  }
  const encoded = environment.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_B64?.trim();
  if (encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
    if (decoded.includes('BEGIN PUBLIC KEY')) return decoded;
  }
  const path = environment.PROJECT_RELEASE_MANIFEST_SIGNING_PUBLIC_KEY_FILE?.trim();
  if (path) {
    try {
      return readFileSync(path);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function createConfiguredConnectorRuntimeDispatcher(input: {
  commandVerificationKey?: KeyLike;
  environment?: NodeJS.ProcessEnv;
  machineId?: string;
  maintenanceSafety: ConnectorRuntimeMaintenanceSafetyCheck;
  maintenanceSelection?: ConnectorRuntimeDispatcherOptions['maintenanceSelection'];
  shutdown(): Promise<void> | void;
}) {
  const environment = input.environment ?? process.env;
  const target = configuredTarget();
  const releaseVerificationKey = releasePublicKey(environment);
  const controlFilePath = environment.PROJECT_CONNECTOR_RUNTIME_CONTROL_FILE?.trim();
  const decisionFilePath = environment.PROJECT_CONNECTOR_RUNTIME_DECISION_FILE?.trim();
  const outcomeFilePath = environment.PROJECT_CONNECTOR_RUNTIME_OUTCOME_FILE?.trim();
  const stagingDirectory = environment.PROJECT_CONNECTOR_RUNTIME_STAGING_DIR?.trim();
  if (environment.PROJECT_SPACE_INSTALL_SOURCE !== 'managed' || !input.commandVerificationKey ||
      !input.machineId || !target || !releaseVerificationKey || !controlFilePath ||
      !decisionFilePath || !stagingDirectory) return undefined;
  try {
    const commandKey = createPublicKey(input.commandVerificationKey);
    const releaseKey = createPublicKey(releaseVerificationKey);
    if (commandKey.asymmetricKeyType !== 'ed25519' || releaseKey.asymmetricKeyType !== 'ed25519')
      return undefined;
    return new ConnectorRuntimeCommandDispatcher({
      commandVerificationKey: commandKey,
      controlFilePath,
      decisionFilePath,
      expectedMachineId: input.machineId,
      expectedTarget: target,
      maintenanceSafety: input.maintenanceSafety,
      maintenanceSelection: input.maintenanceSelection,
      outcomeFilePath,
      releaseVerificationKey: releaseKey,
      shutdown: input.shutdown,
      stagingDirectory
    });
  } catch {
    return undefined;
  }
}

export function connectorRegistryForRuntimeConfiguration(
  registry: ConnectorProjectRegistryResult,
  configured: boolean | readonly string[]
) {
  const supported = new Set(
    typeof configured !== 'boolean'
      ? configured.filter((entry) => runtimeCapabilities.has(entry))
      : configured
        ? managedRuntimeCapabilities
        : []
  );
  if (!registry.connector.capabilities?.some(
    (entry) => runtimeCapabilities.has(entry) && !supported.has(entry)
  )) {
    return registry;
  }
  return {
    ...registry,
    connector: {
      ...registry.connector,
      capabilities: registry.connector.capabilities.filter(
        (entry) => !runtimeCapabilities.has(entry) || supported.has(entry)
      )
    }
  };
}
