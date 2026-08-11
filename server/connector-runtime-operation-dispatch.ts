import type {
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeOperationState
} from '../src/shared/connector-runtime-api';
import type { ConnectorRuntimeCommandPlan } from './connector-runtime-command-contract';
import {
  connectorRuntimeDeferredFailure,
  connectorRuntimeDispatchFailure,
  connectorRuntimeOutcomeUnknownFailure
} from './connector-runtime-maintenance-health';
import type { ConnectorRuntimeOperationStore } from './connector-runtime-operation-store';
import { activeConnectorRuntimeOperationStates as activeStates } from './connector-runtime-reconnect';

const deferredCodes = new Set([
  'busy', 'codex-state-uncertain', 'codex-turn-active', 'codex-turn-starting',
  'codex-waiting-approval', 'codex-waiting-input', 'control-conflict',
  'machine-mutation', 'maintenance-in-progress', 'unavailable'
]);

type Progress = 'accepted' | 'staging' | 'validating' | 'verifying';

function progressState(stage: Progress): ConnectorRuntimeOperationState {
  if (stage === 'staging') return 'staging';
  if (stage === 'verifying') return 'verified';
  if (stage === 'accepted') return 'restarting';
  return 'validating';
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' ? error.code.slice(0, 128) : 'internal-error';
}

export function dispatchConnectorRuntimeOperation(input: {
  dispatcher: {
    dispatch(request: {
      onProgress(stage: Progress): void;
      plan: ConnectorRuntimeCommandPlan;
      userId: string;
    }): Promise<void>;
  };
  now(): Date;
  operation: ConnectorRuntimeOperationRecord;
  operations: ConnectorRuntimeOperationStore;
  plan: ConnectorRuntimeCommandPlan;
  userId: string;
}) {
  let transitions = Promise.resolve();
  const transition = (state: ConnectorRuntimeOperationState) => {
    transitions = transitions.then(async () => {
      const now = input.now().toISOString();
      await input.operations.transition({
        expectedStates: activeStates, id: input.operation.id,
        ...(state === 'validating' ? { startedAt: now } : {}), state, updatedAt: now
      });
    });
  };
  void input.dispatcher.dispatch({
    onProgress: (stage) => transition(progressState(stage)),
    plan: input.plan,
    userId: input.userId
  }).then(async () => {
    await transitions;
    transition('reconnecting');
    await transitions;
  }).catch(async (error) => {
    await transitions;
    const now = input.now().toISOString();
    const code = errorCode(error);
    if (code === 'outcome-unknown') {
      await input.operations.transition({
        expectedStates: activeStates, id: input.operation.id,
        lastFailure: connectorRuntimeOutcomeUnknownFailure(
          code, now, input.operation.operation === 'update'
        ),
        state: 'reconnecting', updatedAt: now
      });
      return;
    }
    if (input.operation.operation === 'update' && deferredCodes.has(code)) {
      await input.operations.transition({
        expectedStates: activeStates, id: input.operation.id,
        lastFailure: connectorRuntimeDeferredFailure(code, now),
        state: 'queued', updatedAt: now
      });
      return;
    }
    await input.operations.transition({
      expectedStates: activeStates, finishedAt: now, id: input.operation.id,
      lastFailure: connectorRuntimeDispatchFailure(code, now),
      state: 'failed', updatedAt: now
    });
  });
}
