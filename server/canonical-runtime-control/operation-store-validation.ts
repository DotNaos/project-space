import {
  canonicalRuntimeControlApiVersion,
  type CanonicalRuntimeControlOperation,
  type CanonicalRuntimeControlResult
} from '../../src/shared/canonical-runtime-control-api';
import type {
  CanonicalRuntimeControlFailureCode,
  CanonicalRuntimeControlOperationIdentity
} from './operation-store-contracts';

const idPattern = /^[A-Za-z0-9:._-]{1,256}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const revisionPattern = /^[1-9][0-9]*:[A-Za-z0-9:_-]{8,256}$/;
const actorKinds = new Set(['agent', 'human', 'orchestrator', 'system']);
const operations = new Set(['git.status', 'git.diff', 'worktree.list', 'dev-server.inspect']);
const failureCodes = new Set<CanonicalRuntimeControlFailureCode>([
  'authorization_denied', 'dispatch_outcome_unknown', 'invalid_request', 'runtime_failed',
  'runtime_stopping', 'target_changed', 'target_unavailable', 'unavailable'
]);

export function validateOperationIdentity(identity: CanonicalRuntimeControlOperationIdentity) {
  if (!identity || !idPattern.test(identity.ownerUserId) || !idPattern.test(identity.actorUserId) ||
    !idPattern.test(identity.actorId) || !actorKinds.has(identity.actorKind) ||
    !idPattern.test(identity.operationId) || !operations.has(identity.operation) ||
    !uuidPattern.test(identity.environmentId) || !uuidPattern.test(identity.workspaceId) ||
    !uuidPattern.test(identity.generation) || !uuidPattern.test(identity.sessionId) ||
    !revisionPattern.test(identity.targetIdentityRevision) ||
    (identity.operation === 'git.diff') !== (typeof identity.diffStaged === 'boolean') ||
    typeof identity.compatibilityAlias !== 'boolean') {
    throw new Error('Canonical Runtime control operation identity is invalid.');
  }
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
  state: 'completed' | 'failed' | 'uncertain',
  failureCode: CanonicalRuntimeControlFailureCode | undefined
) {
  const valid = state === 'completed'
    ? failureCode === undefined
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
    (result.state !== 'completed' && result.state !== 'failed')) throw invalidResult();
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
      value.staged !== identity.diffStaged) {
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
  exactKeys(value, ['failed', 'ready', 'starting', 'stopped', 'total']);
  if (!['failed', 'ready', 'starting', 'stopped', 'total']
    .every((key) => safeCount(value[key])) ||
    Number(value.failed) + Number(value.ready) + Number(value.starting) + Number(value.stopped) !==
      Number(value.total)) throw invalidResult();
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidResult();
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
