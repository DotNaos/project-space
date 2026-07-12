import { isAbsolute } from 'node:path';
import type { WorktreeSetupState } from '../src/shared/worktree-action-api';

export type ConnectorWorktreeActionOperation = 'materialize' | 'setup.inspect' | 'setup.run';

export interface ConnectorWorktreeActionActor {
  generation: number;
  userId: string;
}

interface TrustedBase {
  machineId: string;
  operation: ConnectorWorktreeActionOperation;
  projectId: string;
  repositoryFullName: string;
}

export interface ConnectorWorktreeMaterializeTrustedRequest extends TrustedBase {
  branchName: string;
  commitSha: string;
  operation: 'materialize';
}

export interface ConnectorWorktreeSetupTrustedRequest extends TrustedBase {
  declarationDigest?: string;
  expectedHeadSha: string;
  operation: 'setup.inspect' | 'setup.run';
  setupStepId?: string;
  worktreeId: string;
}

export type ConnectorWorktreeActionTrustedRequest =
  ConnectorWorktreeMaterializeTrustedRequest | ConnectorWorktreeSetupTrustedRequest;

export interface ConnectorWorktreeActionGrant {
  branchName?: string;
  commitSha?: string;
  declarationDigest?: string;
  expectedHeadSha?: string;
  expiresAt: string;
  generation: number;
  issuedAt: string;
  machineId: string;
  nonce: string;
  operation: ConnectorWorktreeActionOperation;
  projectId: string;
  repositoryFullName: string;
  setupStepId?: string;
  signature: string;
  userId: string;
  worktreeId?: string;
}

export type ConnectorWorktreeActionWireRequest = ConnectorWorktreeActionTrustedRequest & {
  grant: ConnectorWorktreeActionGrant;
};

export interface ConnectorWorktreeMaterializeConnectorResult {
  branchName: string;
  checkedAt: string;
  commitSha: string;
  generation: number;
  lastError?: string;
  machineId: string;
  operation: 'materialize';
  projectId: string;
  projectPath?: string;
  state: 'created' | 'ready' | 'error';
  worktreePath?: string;
}

export interface ConnectorWorktreeSetupStepResult {
  checkedAt: string;
  commitSha: string;
  declarationDigest: string;
  finishedAt?: string;
  lastError?: string;
  setupStepId: string;
  startedAt?: string;
  state: WorktreeSetupState;
}

export interface ConnectorWorktreeSetupConnectorResult {
  capability: 'configured' | 'unavailable';
  checkedAt: string;
  generation: number;
  lastError?: string;
  machineId: string;
  operation: 'setup.inspect' | 'setup.run';
  projectId: string;
  steps: ConnectorWorktreeSetupStepResult[];
  worktreeId: string;
}

export type ConnectorWorktreeActionResult =
  ConnectorWorktreeMaterializeConnectorResult | ConnectorWorktreeSetupConnectorResult;

export interface ConnectorWorktreeActionAdapter {
  runWorktreeAction(
    request: ConnectorWorktreeActionTrustedRequest & {
      actor: ConnectorWorktreeActionActor;
    }
  ): Promise<ConnectorWorktreeActionResult>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const fullName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const digest = /^[0-9a-f]{64}$/;
const step = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 2048): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function date(value: unknown) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
function optionalText(value: unknown, max: number) {
  return value === undefined || text(value, max);
}
function optionalDate(value: unknown) {
  return value === undefined || date(value);
}

export function isConnectorWorktreeActionWireRequest(
  value: unknown
): value is ConnectorWorktreeActionWireRequest {
  if (
    !record(value) ||
    !record(value.grant) ||
    !identifier.test(String(value.machineId)) ||
    !text(value.projectId) ||
    !fullName.test(String(value.repositoryFullName))
  )
    return false;
  if (
    !['materialize', 'setup.inspect', 'setup.run'].includes(String(value.operation)) ||
    value.grant.operation !== value.operation
  )
    return false;
  const grant = value.grant;
  if (
    !text(grant.userId) ||
    grant.machineId !== value.machineId ||
    grant.projectId !== value.projectId ||
    grant.repositoryFullName !== value.repositoryFullName ||
    !Number.isSafeInteger(grant.generation) ||
    !text(grant.nonce, 256) ||
    !date(grant.issuedAt) ||
    !date(grant.expiresAt) ||
    typeof grant.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{40,512}$/.test(grant.signature)
  )
    return false;
  if (value.operation === 'materialize')
    return (
      only(value, [
        'branchName',
        'commitSha',
        'grant',
        'machineId',
        'operation',
        'projectId',
        'repositoryFullName'
      ]) &&
      only(grant, [
        'branchName',
        'commitSha',
        'expiresAt',
        'generation',
        'issuedAt',
        'machineId',
        'nonce',
        'operation',
        'projectId',
        'repositoryFullName',
        'signature',
        'userId'
      ]) &&
      text(value.branchName, 255) &&
      sha.test(String(value.commitSha)) &&
      grant.branchName === value.branchName &&
      grant.commitSha === value.commitSha &&
      grant.expectedHeadSha === undefined &&
      grant.worktreeId === undefined &&
      grant.setupStepId === undefined &&
      grant.declarationDigest === undefined
    );
  if (
    !/^wt_[a-f0-9]{24}$/.test(String(value.worktreeId)) ||
    !sha.test(String(value.expectedHeadSha)) ||
    grant.worktreeId !== value.worktreeId ||
    grant.expectedHeadSha !== value.expectedHeadSha ||
    grant.branchName !== undefined
  )
    return false;
  if (value.operation === 'setup.run')
    return (
      only(value, [
        'declarationDigest',
        'expectedHeadSha',
        'grant',
        'machineId',
        'operation',
        'projectId',
        'repositoryFullName',
        'setupStepId',
        'worktreeId'
      ]) &&
      only(grant, [
        'declarationDigest',
        'expectedHeadSha',
        'expiresAt',
        'generation',
        'issuedAt',
        'machineId',
        'nonce',
        'operation',
        'projectId',
        'repositoryFullName',
        'setupStepId',
        'signature',
        'userId',
        'worktreeId'
      ]) &&
      step.test(String(value.setupStepId)) &&
      digest.test(String(value.declarationDigest)) &&
      grant.setupStepId === value.setupStepId &&
      grant.commitSha === undefined &&
      grant.declarationDigest === value.declarationDigest
    );
  return (
    only(value, [
      'expectedHeadSha',
      'grant',
      'machineId',
      'operation',
      'projectId',
      'repositoryFullName',
      'worktreeId'
    ]) &&
    only(grant, [
      'expectedHeadSha',
      'expiresAt',
      'generation',
      'issuedAt',
      'machineId',
      'nonce',
      'operation',
      'projectId',
      'repositoryFullName',
      'signature',
      'userId',
      'worktreeId'
    ]) &&
    value.setupStepId === undefined &&
    value.commitSha === undefined &&
    value.declarationDigest === undefined &&
    grant.setupStepId === undefined &&
    grant.commitSha === undefined &&
    grant.declarationDigest === undefined
  );
}

export function isConnectorWorktreeActionResult(
  value: unknown
): value is ConnectorWorktreeActionResult {
  if (
    !record(value) ||
    !identifier.test(String(value.machineId)) ||
    !text(value.projectId) ||
    !date(value.checkedAt) ||
    !Number.isSafeInteger(value.generation)
  )
    return false;
  if (value.operation === 'materialize')
    return (
      only(value, [
        'branchName',
        'checkedAt',
        'commitSha',
        'generation',
        'lastError',
        'machineId',
        'operation',
        'projectId',
        'projectPath',
        'state',
        'worktreePath'
      ]) &&
      text(value.branchName, 255) &&
      sha.test(String(value.commitSha)) &&
      ['created', 'ready', 'error'].includes(String(value.state)) &&
      optionalText(value.lastError, 500) &&
      (value.projectPath === undefined ||
        (text(value.projectPath, 4096) && isAbsolute(value.projectPath))) &&
      (value.worktreePath === undefined ||
        (text(value.worktreePath, 4096) && isAbsolute(value.worktreePath)))
    );
  if (value.operation !== 'setup.inspect' && value.operation !== 'setup.run') return false;
  return (
    only(value, [
      'capability',
      'checkedAt',
      'generation',
      'lastError',
      'machineId',
      'operation',
      'projectId',
      'steps',
      'worktreeId'
    ]) &&
    text(value.worktreeId) &&
    ['configured', 'unavailable'].includes(String(value.capability)) &&
    optionalText(value.lastError, 500) &&
    Array.isArray(value.steps) &&
    value.steps.length <= 64 &&
    value.steps.every(
      (candidate) =>
        record(candidate) &&
        only(candidate, [
          'checkedAt',
          'commitSha',
          'declarationDigest',
          'finishedAt',
          'lastError',
          'setupStepId',
          'startedAt',
          'state'
        ]) &&
        step.test(String(candidate.setupStepId)) &&
        sha.test(String(candidate.commitSha)) &&
        digest.test(String(candidate.declarationDigest)) &&
        date(candidate.checkedAt) &&
        optionalDate(candidate.startedAt) &&
        optionalDate(candidate.finishedAt) &&
        optionalText(candidate.lastError, 500) &&
        ['required', 'running', 'ready', 'failed', 'interrupted', 'stale'].includes(
          String(candidate.state)
        )
    )
  );
}
