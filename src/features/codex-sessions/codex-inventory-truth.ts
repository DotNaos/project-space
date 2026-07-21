import type {
  MachineRecord,
  MachineRuntimeStatusResult
} from '@/shared/project-space-api';
import {
  CODEX_SESSION_INVENTORY_CLOCK_SKEW_MS,
  CODEX_SESSION_INVENTORY_EVIDENCE_MAX_AGE_MS
} from '../../shared/codex-session-inventory-window';
import type { CodexMachine } from './codex-sessions-types';

export const CODEX_SESSIONS_CONNECTOR_CAPABILITY = 'codex.sessions.v1';

export type CodexInventoryTruthState =
  | 'blocked'
  | 'checking'
  | 'ready'
  | 'restarting'
  | 'update-required'
  | 'updating';

export interface CodexInventoryTruth {
  detail: string;
  label: string;
  state: CodexInventoryTruthState;
}

export interface CodexInventoryTruthInput {
  connector?: MachineRecord;
  connectorRequired?: boolean;
  inventory?: CodexMachine;
  loading?: boolean;
  now?: Date;
  overviewRefreshing?: boolean;
  runtime?: MachineRuntimeStatusResult;
}

const activeOperationStates = new Set([
  'health-checking',
  'queued',
  'reconnecting',
  'restarting',
  'rolling-back',
  'staging',
  'switching',
  'validating',
  'verified'
]);

function truth(
  state: CodexInventoryTruthState,
  detail: string
): CodexInventoryTruth {
  const labels: Record<CodexInventoryTruthState, string> = {
    blocked: 'Blocked',
    checking: 'Checking',
    ready: 'Ready',
    restarting: 'Restarting',
    'update-required': 'Update required',
    updating: 'Updating'
  };
  return { detail, label: labels[state], state };
}

function currentRuntimeState(input: CodexInventoryTruthInput) {
  return input.runtime?.update ?? input.connector?.connector.update;
}

function operationTruth(input: CodexInventoryTruthInput) {
  const updates = [input.runtime?.update, input.connector?.connector.update].filter(Boolean);
  for (const update of updates) {
    const operation = update?.operation;
    if (operation && activeOperationStates.has(operation.state)) {
      return operation.operation === 'update'
        ? truth('updating', 'The connector update is in progress. Codex will be checked again after it reconnects.')
        : truth('restarting', 'The connector is restarting. Codex will be checked again after it reconnects.');
    }
    if (update?.state === 'updating') {
      return truth('updating', 'The connector update is in progress. Codex will be checked again after it reconnects.');
    }
    if (update?.state === 'restarting') {
      return truth('restarting', 'The connector is restarting. Codex will be checked again after it reconnects.');
    }
  }
  return undefined;
}

function isOnline(input: CodexInventoryTruthInput) {
  if (input.runtime && !input.runtime.online) return false;
  const status = input.connector?.connector.status;
  return status === undefined || status === 'local' || status === 'online';
}

function capabilityEvidence(input: CodexInventoryTruthInput) {
  return input.connector?.connector.capabilities ?? input.runtime?.capabilities ?? [];
}

function currentInstanceId(input: CodexInventoryTruthInput) {
  return input.connector?.connector.runtime?.instanceId ?? input.runtime?.runtime?.instanceId;
}

function runtimeEvidenceDisagrees(input: CodexInventoryTruthInput) {
  const runtimeInstance = input.runtime?.runtime?.instanceId;
  const overviewInstance = input.connector?.connector.runtime?.instanceId;
  return Boolean(runtimeInstance && overviewInstance && runtimeInstance !== overviewInstance);
}

function hasMatchingLiveInventory(input: CodexInventoryTruthInput) {
  const inventory = input.inventory;
  if (inventory?.inventoryState !== 'live') return false;
  const publishedAt = Date.parse(inventory.inventoryPublishedAt ?? '');
  const observedAt = (input.now ?? new Date()).getTime();
  const ageMs = observedAt - publishedAt;
  if (
    !Number.isFinite(publishedAt)
    || !Number.isFinite(observedAt)
    || ageMs < -CODEX_SESSION_INVENTORY_CLOCK_SKEW_MS
    || ageMs > CODEX_SESSION_INVENTORY_EVIDENCE_MAX_AGE_MS
  ) return false;
  const currentInstance = currentInstanceId(input);
  if (!currentInstance) return true;
  return inventory.inventoryConnectorInstanceId === currentInstance;
}

function updateRequiredTruth(input: CodexInventoryTruthInput) {
  const updates = [input.runtime?.update, input.connector?.connector.update].filter(Boolean);
  const capabilities = capabilityEvidence(input);
  const codexMissing = !capabilities.includes(CODEX_SESSIONS_CONNECTOR_CAPABILITY);
  const required = updates.find((update) => (
    update?.state === 'update-required' || update?.state === 'restart-required'
  ));
  if (required?.state === 'update-required' || required?.state === 'restart-required') {
    return truth(
      'update-required',
      required.state === 'restart-required'
        ? 'Restart the connector before Codex availability can be verified.'
        : 'Install the approved connector update before Codex availability can be verified.'
    );
  }
  const available = updates.find((update) => (
    update?.state === 'update-available'
    || update?.state === 'failed'
    || update?.state === 'rollback'
  ));
  if (codexMissing && available) {
    return truth(
      'update-required',
      available.lastFailure?.message
        ?? available.operation?.lastFailure?.message
        ?? 'This connector does not provide Codex sessions. Install the approved update and check again.'
    );
  }
  return undefined;
}

export function codexInventoryTruth(
  input: CodexInventoryTruthInput
): CodexInventoryTruth {
  if (input.connectorRequired && !input.connector) {
    return input.overviewRefreshing
      ? truth('checking', 'Checking the authenticated connector and its Codex support.')
      : truth(
          'blocked',
          input.inventory
            ? 'This connector is not present in the authenticated machine inventory.'
            : 'No authenticated connector is available for this Codex scope.'
        );
  }

  const maintenance = operationTruth(input);
  if (maintenance) return maintenance;

  if (!input.connector && !input.inventory) {
    return input.loading || input.overviewRefreshing
      ? truth('checking', 'Checking the authenticated connector and its Codex support.')
      : truth('blocked', 'This connector is not present in the authenticated machine inventory.');
  }

  if (!isOnline(input)) {
    return truth('blocked', 'The connector is offline, so a current Codex inventory cannot be verified.');
  }

  if (runtimeEvidenceDisagrees(input)) {
    return truth('checking', 'The connector changed. Checking Codex again for the current connector instance.');
  }

  const updateRequired = updateRequiredTruth(input);
  if (updateRequired) return updateRequired;

  const inventory = input.inventory;
  if (inventory?.inventoryState === 'stale') {
    return truth(
      'blocked',
      inventory.statusDetail ?? 'Only a saved Codex inventory is available; the current connector response is unproven.'
    );
  }
  if (inventory?.status === 'offline' || inventory?.status === 'unavailable') {
    return truth(
      'blocked',
      inventory.statusDetail ?? 'The connector did not return a current Codex inventory.'
    );
  }

  const capabilities = capabilityEvidence(input);
  if (!capabilities.includes(CODEX_SESSIONS_CONNECTOR_CAPABILITY)) {
    const unsupported = currentRuntimeState(input)?.state === 'unsupported';
    return truth(
      'blocked',
      unsupported
        ? 'This installation cannot be updated from Project Space and does not provide Codex sessions.'
        : 'The current connector has not advertised Codex session support.'
    );
  }

  if (hasMatchingLiveInventory(input)) {
    return truth('ready', 'A compatible connector returned a current Codex inventory.');
  }

  const currentInstance = currentInstanceId(input);
  if (
    inventory?.inventoryState === 'live'
    && currentInstance
    && inventory.inventoryConnectorInstanceId !== currentInstance
  ) {
    return truth('checking', 'The connector changed. Checking Codex again for the current connector instance.');
  }
  if (inventory?.inventoryState === 'live') {
    return truth(
      'checking',
      'Checking Codex again because the last current inventory is no longer fresh.'
    );
  }
  return truth('checking', 'Waiting for the compatible connector to return a current Codex inventory.');
}

export function aggregateCodexInventoryTruth(
  values: readonly CodexInventoryTruth[]
): CodexInventoryTruth {
  if (values.length === 0) {
    return truth('checking', 'Checking for authenticated connectors with Codex support.');
  }
  if (values.every((value) => value.state === 'ready')) {
    return truth('ready', 'Every connector in scope returned a current Codex inventory.');
  }
  for (const state of [
    'updating',
    'restarting',
    'update-required',
    'blocked',
    'checking'
  ] as const) {
    const matching = values.find((value) => value.state === state);
    if (matching) return matching;
  }
  return truth('checking', 'Checking the current Codex inventory.');
}
