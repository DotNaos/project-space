import {
  canonicalRuntimeControlAccessMode,
  canonicalRuntimeControlApiVersion,
  canonicalRuntimeControlOperations,
  type CanonicalRuntimeControlOperation,
  type CanonicalRuntimeControlResult,
  type CanonicalRuntimeControlSafeInput
} from '../../src/shared/canonical-runtime-control-api';
import type {
  CanonicalRuntimeControlFailureCode,
  CanonicalRuntimeControlOperationIdentity
} from './operation-store-contracts';

const idPattern = /^[A-Za-z0-9:._-]{1,256}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revisionPattern = /^[1-9][0-9]*:[A-Za-z0-9:_-]{8,256}$/;
const actorKinds = new Set(['agent', 'human', 'orchestrator', 'system']);
const operations = new Set<string>(canonicalRuntimeControlOperations);
const failureCodes = new Set<CanonicalRuntimeControlFailureCode>([
  'authorization_denied', 'blocked_dependency', 'dispatch_outcome_unknown', 'invalid_request', 'runtime_failed',
  'runtime_stopping', 'target_changed', 'target_unavailable', 'unavailable'
]);

export function validateOperationIdentity(identity: CanonicalRuntimeControlOperationIdentity) {
  if (!identity || !idPattern.test(identity.ownerUserId) || !idPattern.test(identity.actorUserId) ||
    !idPattern.test(identity.actorId) || !actorKinds.has(identity.actorKind) ||
    !idPattern.test(identity.operationId) || !operations.has(identity.operation) ||
    !uuidPattern.test(identity.environmentId) || !uuidPattern.test(identity.workspaceId) ||
    !uuidPattern.test(identity.generation) || !uuidPattern.test(identity.sessionId) ||
    !revisionPattern.test(identity.targetIdentityRevision) ||
    identity.accessMode !== canonicalRuntimeControlAccessMode(identity.operation) ||
    !sameJson(identity.safeInput, validateSafeInput(identity.safeInput)) ||
    identity.safeInput.operation !== identity.operation ||
    typeof identity.compatibilityAlias !== 'boolean') {
    throw new Error('Canonical Runtime control operation identity is invalid.');
  }
}

export function validateSafeInput(input: CanonicalRuntimeControlSafeInput) {
  if (!isRecord(input) || !operations.has(String(input.operation))) throw invalidInput();
  if (input.operation === 'git.status' || input.operation === 'worktree.list' ||
      input.operation === 'dev-server.inspect') {
    exactInputKeys(input, ['operation']);
  } else if (input.operation === 'git.diff') {
    exactInputKeys(input, ['operation', 'staged']);
    if (typeof input.staged !== 'boolean') throw invalidInput();
  } else if (input.operation === 'git.stage' || input.operation === 'git.unstage') {
    exactInputKeys(input, ['expectedHead', 'operation', 'scope']);
    if (input.scope !== 'all' || !gitSha(input.expectedHead)) throw invalidInput();
  } else if (input.operation === 'git.commit') {
    exactInputKeys(input, ['expectedHead', 'message', 'operation']);
    if (!gitSha(input.expectedHead) || !safeCommitMessage(input.message)) throw invalidInput();
  } else if (input.operation === 'task.start') {
    exactInputKeys(input, ['operation', 'taskExecutionId', 'workspaceLeaseId']);
    if (!uuidPattern.test(input.taskExecutionId) || !uuidPattern.test(input.workspaceLeaseId)) {
      throw invalidInput();
    }
  } else if (input.operation === 'dev-server.start') {
    exactInputKeys(input, ['operation', 'serverId']);
    if (!serverId(input.serverId)) throw invalidInput();
  } else {
    exactInputKeys(input, ['expectedServerGeneration', 'operation', 'serverId']);
    if (!serverId(input.serverId) || !resourceGeneration(input.expectedServerGeneration)) {
      throw invalidInput();
    }
  }
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 65_536) throw invalidInput();
  return input;
}

export function validateFingerprint(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('Canonical Runtime control operation fingerprint is invalid.');
  }
}

export function validateInstant(value: string, label = 'timestamp') {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Canonical Runtime control ${label} is invalid.`);
  }
}

export function validatePositiveSequence(value: number, label = 'sequence') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Canonical Runtime control ${label} is invalid.`);
  }
}

export function validateFailureCode(
  state: 'blocked_dependency' | 'completed' | 'failed' | 'uncertain',
  failureCode: CanonicalRuntimeControlFailureCode | undefined
) {
  const valid = state === 'completed'
    ? failureCode === undefined
    : state === 'blocked_dependency'
      ? failureCode === 'blocked_dependency'
    : state === 'uncertain'
      ? failureCode === 'dispatch_outcome_unknown'
      : failureCode !== undefined && failureCode !== 'dispatch_outcome_unknown' &&
        failureCodes.has(failureCode);
  if (!valid) throw new Error('Canonical Runtime control failure evidence is invalid.');
}

export function validateSafeResult(
  result: CanonicalRuntimeControlResult,
  identity: CanonicalRuntimeControlOperationIdentity,
  failureCode?: CanonicalRuntimeControlFailureCode
) {
  if (!isRecord(result) || result.apiVersion !== canonicalRuntimeControlApiVersion ||
    result.compatibilityAlias !== identity.compatibilityAlias ||
    result.environmentId !== identity.environmentId || result.generation !== identity.generation ||
    result.operation !== identity.operation || result.operationId !== identity.operationId ||
    result.replayed !== false || result.targetIdentityRevision !== identity.targetIdentityRevision ||
    result.workspaceId !== identity.workspaceId ||
    (result.state !== 'completed' && result.state !== 'failed' &&
      result.state !== 'blocked_dependency') ||
    (result.state === 'blocked_dependency') !==
      (identity.operation === 'task.start' && failureCode === 'blocked_dependency') ||
    (failureCode === 'blocked_dependency' && result.state !== 'blocked_dependency')) {
    throw invalidResult();
  }
  validateFailureCode(result.state, failureCode);
  exactKeys(result, result.state === 'completed'
    ? ['apiVersion', 'compatibilityAlias', 'environmentId', 'generation', 'operation',
      'operationId', 'output', 'replayed', 'state', 'targetIdentityRevision', 'workspaceId']
    : ['apiVersion', 'compatibilityAlias', 'environmentId', 'generation', 'operation',
      'operationId', 'replayed', 'state', 'targetIdentityRevision', 'workspaceId']);
  if (result.state === 'completed') validateOutput(result.operation, result.output, identity);
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > 262_144) throw invalidResult();
}

function validateOutput(
  operation: CanonicalRuntimeControlOperation,
  value: unknown,
  identity: CanonicalRuntimeControlOperationIdentity
) {
  if (!isRecord(value)) throw invalidResult();
  if (operation === 'git.status') {
    exactKeys(value, ['clean', 'conflicted', 'staged', 'truncated', 'unstaged', 'untracked']);
    for (const key of ['conflicted', 'staged', 'unstaged', 'untracked']) {
      if (!safeCount(value[key])) throw invalidResult();
    }
    if (typeof value.clean !== 'boolean' || typeof value.truncated !== 'boolean') throw invalidResult();
    return;
  }
  if (operation === 'git.diff') {
    exactKeys(value, [
      'addedLines', 'binaryFiles', 'changedFiles', 'deletedLines', 'staged', 'truncated'
    ]);
    if (!['addedLines', 'binaryFiles', 'changedFiles', 'deletedLines']
      .every((key) => safeCount(value[key])) || typeof value.truncated !== 'boolean' ||
      identity.safeInput.operation !== 'git.diff' ||
      value.staged !== identity.safeInput.staged) {
      throw invalidResult();
    }
    return;
  }
  if (operation === 'git.stage' || operation === 'git.unstage') {
    exactKeys(value, [
      'changed', 'clean', 'conflicted', 'head', 'staged', 'truncated', 'unstaged', 'untracked'
    ]);
    if (typeof value.changed !== 'boolean' || typeof value.clean !== 'boolean' ||
        typeof value.truncated !== 'boolean' || !gitSha(value.head) ||
        (identity.safeInput.operation !== 'git.stage' &&
          identity.safeInput.operation !== 'git.unstage') ||
        value.head !== identity.safeInput.expectedHead ||
        !['conflicted', 'staged', 'unstaged', 'untracked'].every((key) => safeCount(value[key]))) {
      throw invalidResult();
    }
    return;
  }
  if (operation === 'git.commit') {
    exactKeys(value, ['commit', 'parent']);
    if (!gitSha(value.commit) || !gitSha(value.parent) || value.commit === value.parent ||
        identity.safeInput.operation !== 'git.commit' ||
        value.parent !== identity.safeInput.expectedHead) {
      throw invalidResult();
    }
    return;
  }
  if (operation === 'worktree.list') {
    exactKeys(value, ['current', 'detached', 'locked', 'prunable', 'total', 'truncated']);
    if (!['current', 'detached', 'locked', 'prunable', 'total']
      .every((key) => safeCount(value[key])) || typeof value.truncated !== 'boolean' ||
      Number(value.current) > 1 || ['current', 'detached', 'locked', 'prunable']
        .some((key) => Number(value[key]) > Number(value.total))) throw invalidResult();
    return;
  }
  if (operation === 'task.start') {
    exactKeys(value, ['state', 'taskExecutionId']);
    if (value.state !== 'ready_for_agent' || !uuidPattern.test(String(value.taskExecutionId)) ||
        identity.safeInput.operation !== 'task.start' ||
        value.taskExecutionId !== identity.safeInput.taskExecutionId) throw invalidResult();
    return;
  }
  if (operation === 'dev-server.inspect') {
    exactKeys(value, ['failed', 'ready', 'starting', 'stopped', 'total']);
    if (!['failed', 'ready', 'starting', 'stopped', 'total']
      .every((key) => safeCount(value[key])) ||
      Number(value.failed) + Number(value.ready) + Number(value.starting) + Number(value.stopped) !==
        Number(value.total)) throw invalidResult();
    return;
  }
  exactKeys(value, ['serverGeneration', 'serverId', 'state']);
  const expectedState = operation === 'dev-server.start'
    ? 'ready'
    : operation === 'dev-server.publish' ? 'published' : 'stopped';
  if (!resourceGeneration(value.serverGeneration) ||
      !serverId(value.serverId) || value.state !== expectedState ||
      !identity.safeInput.operation.startsWith('dev-server.') ||
      !('serverId' in identity.safeInput) || value.serverId !== identity.safeInput.serverId ||
      (operation === 'dev-server.publish' &&
        (!('expectedServerGeneration' in identity.safeInput) ||
          value.serverGeneration === identity.safeInput.expectedServerGeneration)) ||
      (operation === 'dev-server.stop' &&
        (!('expectedServerGeneration' in identity.safeInput) ||
          value.serverGeneration !== identity.safeInput.expectedServerGeneration))) {
    throw invalidResult();
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidResult();
  }
}

function exactInputKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidInput();
  }
}

function safeCount(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalidResult() {
  return new Error('Canonical Runtime control safe result is invalid.');
}

function invalidInput() {
  return new Error('Canonical Runtime control safe input is invalid.');
}

function gitSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function safeCommitMessage(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    new TextEncoder().encode(value).byteLength <= 256;
}

function serverId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function resourceGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:._-]{1,256}$/.test(value);
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}
