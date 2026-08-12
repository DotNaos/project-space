import { createHash } from 'node:crypto';

import {
  canonicalRuntimeControlApiVersion,
  canonicalRuntimeControlOperations,
  type CanonicalRuntimeControlRequest,
  type CanonicalRuntimeControlResult,
  type LegacyConnectorControlAliasRequest
} from '../../src/shared/canonical-runtime-control-api';
import type {
  CanonicalRuntimeControlActor,
  CanonicalRuntimeControlAuthorizer,
  CanonicalRuntimeControlDispatcher,
  CanonicalRuntimeControlInventory,
  CanonicalRuntimeControlOperationStore
} from './contracts';
import { CanonicalRuntimeControlError } from './contracts';
import {
  canonicalRequestFromLegacyAlias,
  resolveCanonicalRuntimeControlTarget
} from './resolver';

export function createCanonicalRuntimeControlService(dependencies: {
  authorizer: CanonicalRuntimeControlAuthorizer;
  dispatcher: CanonicalRuntimeControlDispatcher;
  inventory: CanonicalRuntimeControlInventory;
  operations: CanonicalRuntimeControlOperationStore;
}) {
  async function execute(
    actor: CanonicalRuntimeControlActor,
    raw: CanonicalRuntimeControlRequest,
    compatibilityAlias = false
  ): Promise<CanonicalRuntimeControlResult> {
    const request = validate(raw);
    const target = await resolveCanonicalRuntimeControlTarget(
      dependencies.inventory,
      actor.ownerUserId,
      request
    );
    if (!await dependencies.authorizer.authorize({
      actor, operation: request.operation, phase: 'target_resolution', target
    })) denied();
    const fingerprint = sha(stableJson({ actor, request }));
    const reservation = await dependencies.operations.reserve(
      actor.ownerUserId,
      request.operationId,
      fingerprint
    );
    if (reservation.kind === 'conflict') {
      throw new CanonicalRuntimeControlError(
        'operation_conflict',
        'The operation ID belongs to different canonical input.'
      );
    }
    if (reservation.kind === 'replayed') {
      if (reservation.record.result) {
        return {
          ...reservation.record.result,
          compatibilityAlias,
          replayed: true
        };
      }
      throw new CanonicalRuntimeControlError(
        'operation_in_progress',
        'The canonical operation is already in progress or needs reconciliation.'
      );
    }
    if (!await dependencies.authorizer.authorize({
      actor, operation: request.operation, phase: 'execution', target
    })) denied();
    try {
      const dispatched = await dependencies.dispatcher.dispatch({ actor, request, target });
      const result: CanonicalRuntimeControlResult = {
        apiVersion: canonicalRuntimeControlApiVersion,
        compatibilityAlias,
        environmentId: target.environmentId,
        generation: target.generation,
        operation: request.operation,
        operationId: request.operationId,
        ...(dispatched.output ? { output: dispatched.output } : {}),
        replayed: false,
        state: dispatched.state,
        targetIdentityRevision: target.targetIdentityRevision,
        workspaceId: target.workspaceId
      };
      await dependencies.operations.complete(actor.ownerUserId, request.operationId, {
        fingerprint,
        result
      });
      return result;
    } catch (error) {
      await dependencies.operations.markUncertain(
        actor.ownerUserId,
        request.operationId,
        fingerprint
      );
      if (error instanceof CanonicalRuntimeControlError) throw error;
      return {
        apiVersion: canonicalRuntimeControlApiVersion,
        compatibilityAlias,
        environmentId: target.environmentId,
        generation: target.generation,
        operation: request.operation,
        operationId: request.operationId,
        replayed: false,
        state: 'uncertain',
        targetIdentityRevision: target.targetIdentityRevision,
        workspaceId: target.workspaceId
      };
    }
  }

  return {
    execute: (actor: CanonicalRuntimeControlActor, request: CanonicalRuntimeControlRequest) =>
      execute(actor, request),
    async executeLegacyAlias(
      actor: CanonicalRuntimeControlActor,
      request: LegacyConnectorControlAliasRequest
    ) {
      validateAlias(request);
      const canonical = await canonicalRequestFromLegacyAlias(
        dependencies.inventory,
        actor.ownerUserId,
        request
      );
      return execute(actor, canonical, true);
    }
  };
}

function validate(request: CanonicalRuntimeControlRequest) {
  if (request.apiVersion !== canonicalRuntimeControlApiVersion ||
      !canonicalRuntimeControlOperations.includes(request.operation) ||
      !safeId(request.environmentId) || !safeId(request.workspaceId) ||
      !safeId(request.expectedGeneration) || !safeId(request.operationId) ||
      !/^[1-9][0-9]*:[A-Za-z0-9:_-]{8,256}$/.test(request.expectedTargetIdentityRevision) ||
      !safePayload(request.payload)) invalid();
  return request;
}

function validateAlias(request: LegacyConnectorControlAliasRequest) {
  if (request.apiVersion !== canonicalRuntimeControlApiVersion ||
      !canonicalRuntimeControlOperations.includes(request.operation) ||
      !safeId(request.connectorId) || !safeId(request.workspaceId) ||
      !safeId(request.expectedGeneration) || !safeId(request.operationId) ||
      !safePayload(request.payload)) invalid();
}

function safeId(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9:._-]{1,256}$/.test(value);
}

function safePayload(payload: CanonicalRuntimeControlRequest['payload']) {
  if (payload === undefined) return true;
  const entries = Object.entries(payload);
  return entries.length <= 32 && entries.every(([key, value]) =>
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) &&
    !/(?:password|secret|token|credential|private[_-]?key)/i.test(key) &&
    (value === null || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value) ||
      typeof value === 'string' && value.length <= 2_048 && !/[\u0000-\u001f\u007f]/.test(value))
  );
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
