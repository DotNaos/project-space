import { createHash } from 'node:crypto';

import {
  canonicalRuntimeControlApiVersion,
  canonicalRuntimeControlOperations,
  type CanonicalRuntimeControlRequest,
  type CanonicalRuntimeControlResult
} from '../../src/shared/canonical-runtime-control-api';
import type {
  CanonicalRuntimeControlActor,
  CanonicalRuntimeControlAuthorizer,
  CanonicalRuntimeControlDispatcher,
  CanonicalRuntimeControlInventory
} from './contracts';
import { CanonicalRuntimeControlError } from './contracts';
import { resolveCanonicalRuntimeControlTarget } from './resolver';

export function createCanonicalRuntimeControlService(dependencies: {
  authorizer: CanonicalRuntimeControlAuthorizer;
  dispatcher: CanonicalRuntimeControlDispatcher;
  inventory: CanonicalRuntimeControlInventory;
}) {
  async function execute(
    actor: CanonicalRuntimeControlActor,
    raw: CanonicalRuntimeControlRequest,
    _compatibilityAlias = false
  ): Promise<CanonicalRuntimeControlResult> {
    const request = validate(raw);
    if (!await dependencies.authorizer.authorize({
      actor, operation: request.operation, phase: 'coarse'
    })) denied();
    const fingerprint = sha(stableJson({ actor, request }));
    const replay = await dependencies.dispatcher.replay({ actor, fingerprint, request });
    if (replay === 'conflict') {
      throw new CanonicalRuntimeControlError(
        'operation_conflict', 'The operation ID belongs to different canonical input.'
      );
    }
    if (replay === 'in_progress') {
      throw new CanonicalRuntimeControlError(
        'operation_in_progress', 'The canonical operation is already in progress.'
      );
    }
    if (replay) return replay;
    const authorizedTarget = await resolveCanonicalRuntimeControlTarget(
      dependencies.inventory,
      actor.ownerUserId,
      request
    );
    if (!await dependencies.authorizer.authorize({
      actor, operation: request.operation, phase: 'exact', target: authorizedTarget
    })) denied();
    const target = await resolveCanonicalRuntimeControlTarget(
      dependencies.inventory,
      actor.ownerUserId,
      request
    );
    if (!sameTarget(authorizedTarget, target)) unavailable();
    if (!await dependencies.authorizer.authorize({
      actor, operation: request.operation, phase: 'exact', target
    })) denied();
    return dependencies.dispatcher.dispatch({
      actor,
      fingerprint,
      async freshTarget() {
        const fresh = await resolveCanonicalRuntimeControlTarget(
          dependencies.inventory,
          actor.ownerUserId,
          request
        );
        if (!sameTarget(target, fresh) || !await dependencies.authorizer.authorize({
          actor, operation: request.operation, phase: 'exact', target: fresh
        })) denied();
        return fresh;
      },
      request,
      target
    });
  }

  return {
    execute: (actor: CanonicalRuntimeControlActor, request: CanonicalRuntimeControlRequest) =>
      execute(actor, request)
  };
}

function validate(request: CanonicalRuntimeControlRequest) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      request.apiVersion !== canonicalRuntimeControlApiVersion ||
      !canonicalRuntimeControlOperations.includes(request.operation) ||
      !safeId(request.environmentId) || !safeId(request.workspaceId) ||
      !safeId(request.expectedGeneration) || !safeId(request.operationId) ||
      !/^[1-9][0-9]*:[A-Za-z0-9:_-]{8,256}$/.test(request.expectedTargetIdentityRevision) ||
      request.operation === 'git.diff' && typeof request.staged !== 'boolean' ||
      !exactRequestKeys(request)) invalid();
  return request;
}

function safeId(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9:._-]{1,256}$/.test(value);
}

function exactRequestKeys(request: CanonicalRuntimeControlRequest) {
  const keys = [
    'apiVersion', 'environmentId', 'expectedGeneration', 'expectedTargetIdentityRevision',
    'operation', 'operationId', 'workspaceId', ...(request.operation === 'git.diff' ? ['staged'] : [])
  ];
  return sameKeys(request, keys);
}

function sameKeys(value: object, expected: string[]) {
  return Object.keys(value).sort().join('\0') === expected.sort().join('\0');
}

function sameTarget(left: object, right: object) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function denied(): never {
  throw new CanonicalRuntimeControlError('authorization_denied', 'Canonical runtime control is denied.');
}

function invalid(): never {
  throw new CanonicalRuntimeControlError('invalid_request', 'Canonical runtime control input is invalid.');
}

function unavailable(): never {
  throw new CanonicalRuntimeControlError('target_unavailable', 'The authorized Runtime target changed before dispatch.');
}
