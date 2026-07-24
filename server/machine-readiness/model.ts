import { createHash } from 'node:crypto';

import type { MachineRuntimeStatusResult } from '../../src/shared/connector-runtime-api';
import {
  MACHINE_READINESS_API_VERSION,
  type MachineReadinessCheck,
  type MachineReadinessRepairAction,
  type MachineReadinessResult,
  type MachineReadinessSelector,
  type MachineReadinessState
} from '../../src/shared/machine-readiness-api';
import type {
  MachineRecord,
  PhysicalMachineRecord
} from '../../src/shared/project-space-api';

const codexCapability = 'codex.machine-tasks.v1';
const codexAuthorizationRequiredCapability = 'codex.authorization-required.v1';
const codexRuntimeCapability = 'codex.runtime.v1';
const activeStates = new Set([
  'queued', 'validating', 'staging', 'verified', 'switching', 'restarting',
  'reconnecting', 'health-checking'
]);

export interface MachineReadinessModelInput extends MachineReadinessSelector {
  canRepairConnector?(connectorId: string): boolean;
  checkedAt?: string;
  connectors: readonly MachineRecord[];
  generationFor(connectorId: string): number | undefined;
  physicalMachines: readonly PhysicalMachineRecord[];
  runtimeStatuses?: ReadonlyMap<string, MachineRuntimeStatusResult>;
}

interface EvaluatedCheck {
  action?: MachineReadinessRepairAction;
  check: MachineReadinessCheck;
  operation?: MachineRuntimeStatusResult['update']['operation'];
}

export function evaluateMachineReadiness(
  input: MachineReadinessModelInput
): MachineReadinessResult {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const matches = input.physicalMachines.filter((machine) =>
    input.physicalMachineId
      ? machine.id === input.physicalMachineId
      : input.physicalMachineName
        ? machine.name === input.physicalMachineName
        : false
  );
  if (matches.length !== 1) {
    const ambiguous = matches.length > 1;
    return baseResult({
      checkedAt,
      message: ambiguous
        ? 'More than one physical machine matches this name.'
        : 'The selected physical machine is unavailable or not authorized.',
      state: ambiguous ? 'ambiguous' : 'unauthorized'
    });
  }

  const machine = matches[0]!;
  if (input.connectorId && !machine.connectorIds.includes(input.connectorId)) {
    return baseResult({
      checkedAt,
      machine,
      message: 'The connector does not belong to the selected physical machine.',
      state: 'unauthorized'
    });
  }
  const connectorRecords = new Map(input.connectors.map((entry) => [entry.id, entry]));
  const connectorIds = input.connectorId ? [input.connectorId] : machine.connectorIds;
  const evaluated = connectorIds.map((connectorId) => evaluateConnector(
    connectorId,
    connectorRecords.get(connectorId),
    input.generationFor(connectorId),
    input.runtimeStatuses?.get(connectorId),
    input.canRepairConnector?.(connectorId) ?? true
  ));
  const checks = evaluated.map((entry) => entry.check);
  if (checks.length === 0) {
    return resultFor(machine, checkedAt, checks, 'unsupported',
      'No managed connector installation belongs to this physical machine.');
  }

  const ready = evaluated.filter((entry) => entry.check.state === 'ready');
  if (ready.length > 1 && !input.connectorId) {
    return resultFor(machine, checkedAt, checks, 'ambiguous',
      'More than one connector is ready; select the exact connector installation.');
  }
  if (ready.length === 1) {
    return selectedResult(machine, checkedAt, checks, ready[0]!, 'ready',
      'This physical machine is ready for Project Space machine operations.');
  }

  const outdated = evaluated.filter((entry) => entry.check.state === 'outdated');
  if (outdated.length > 1 && !input.connectorId) {
    return resultFor(machine, checkedAt, checks, 'ambiguous',
      'More than one connector has a safe managed repair; select the exact connector.');
  }
  if (outdated.length === 1) {
    return selectedResult(machine, checkedAt, checks, outdated[0]!, 'degraded',
      'The machine is usable, but its managed connector is outdated.');
  }

  const repairable = evaluated.filter((entry) => entry.check.state === 'repairable');
  if (repairable.length > 1 && !input.connectorId) {
    return resultFor(machine, checkedAt, checks, 'ambiguous',
      'More than one connector has a safe managed repair; select the exact connector.');
  }
  if (repairable.length === 1) {
    return selectedResult(machine, checkedAt, checks, repairable[0]!, 'repairable',
      'A signed managed connector update can make this machine ready.');
  }

  const priority: Array<[MachineReadinessCheck['state'], MachineReadinessState, string]> = [
    ['recovery-required', 'recovery-required',
      'A prior managed repair needs recovery before another operation can start.'],
    ['rolling-back', 'rolling-back', 'A managed repair is rolling back.'],
    ['repairing', 'repairing', 'A managed repair is still in progress.'],
    ['rolled-back', 'rolled-back',
      'The last managed repair rolled back and the machine is not ready.'],
    ['failed', 'failed', 'The last managed repair failed.'],
    ['uncertain', 'uncertain', 'Machine readiness cannot be established safely.'],
    ['authorization-required', 'authorization-required',
      'The machine owner must authorize this managed repair.'],
    ['manually-blocked', 'manually-blocked',
      'The missing prerequisite has no supported managed repair channel.'],
    ['unsupported', 'unsupported',
      'The selected connector or platform does not support managed readiness repair.'],
    ['unreachable', 'unreachable', 'No selected connector is currently reachable.']
  ];
  for (const [checkState, state, message] of priority) {
    const selected = evaluated.find((entry) => entry.check.state === checkState);
    if (selected) {
      return selectedResult(machine, checkedAt, checks, selected, state, message);
    }
  }
  return resultFor(machine, checkedAt, checks, 'uncertain',
    'Machine readiness cannot be established safely.');
}

function evaluateConnector(
  connectorId: string,
  connector: MachineRecord | undefined,
  generation: number | undefined,
  runtimeStatus: MachineRuntimeStatusResult | undefined,
  canRepair: boolean
): EvaluatedCheck {
  if (!connector) {
    return {
      check: {
        capabilities: [], connectorId, connectorName: connectorId, online: false,
        state: 'unreachable', summary: 'The connector installation is not reporting.'
      }
    };
  }
  const capabilities = [...new Set(connector.connector.capabilities ?? [])].sort();
  const runtime = runtimeStatus?.runtime ?? connector.connector.runtime;
  const operation = runtimeStatus?.update.operation;
  const common = {
    capabilities,
    connectorId,
    connectorName: connector.name,
    online: connector.connector.status === 'online' || connector.connector.status === 'local',
    ...(runtime?.source ? { runtimeSource: runtime.source } : {}),
    ...(runtime?.version ? { runtimeVersion: runtime.version } : {}),
    ...(runtimeStatus?.update.state ? { updateState: runtimeStatus.update.state } : {})
  };

  if (operation?.state === 'recovery-required') {
    return { check: { ...common, state: 'recovery-required',
      summary: 'The prior managed repair requires recovery.' }, operation };
  }
  if (operation?.state === 'rolling-back') {
    return { check: { ...common, state: 'rolling-back',
      summary: 'The prior managed repair is rolling back.' }, operation };
  }
  if (operation && activeStates.has(operation.state)) {
    return { check: { ...common, state: 'repairing',
      summary: 'A managed connector repair is in progress.' }, operation };
  }
  if (operation?.state === 'rolled-back') {
    return { check: { ...common, state: 'rolled-back',
      summary: 'The prior managed repair rolled back.' }, operation };
  }
  if (operation?.state === 'failed') {
    return { check: { ...common, state: 'failed',
      summary: 'The prior managed repair failed.' }, operation };
  }
  if (!common.online) {
    return { check: { ...common, state: 'unreachable',
      summary: 'The connector installation is offline.' }, operation };
  }

  const codexReady = capabilities.includes(codexCapability) && generation !== undefined;
  const update = runtimeStatus?.update;
  const action = repairAction(connectorId, runtimeStatus);
  if (codexReady) {
    return action
      ? { action, check: { ...common, state: 'outdated',
          summary: 'Codex operations are available, but a signed connector update is approved.' },
          operation }
      : { check: { ...common, state: 'ready',
          summary: 'The connector is online and Codex-capable.' }, operation };
  }
  if (capabilities.includes(codexCapability)) {
    if (action?.kind === 'restart-connector') {
      if (!canRepair) {
        return { check: { ...common, state: 'authorization-required',
          summary: 'Only the machine owner may authorize this managed restart.' },
          operation };
      }
      return { action, check: { ...common, state: 'repairable',
        summary: 'A constrained managed restart can restore the stale Codex session.' },
        operation };
    }
    return { check: { ...common, state: 'uncertain',
      summary: 'The connector capability is present, but its live session is stale.' }, operation };
  }
  if (capabilities.includes(codexAuthorizationRequiredCapability)) {
    if (action) {
      if (!canRepair) {
        return { check: { ...common, state: 'authorization-required',
          summary: 'Only the machine owner may authorize this managed update.' },
          operation };
      }
      return { action, check: { ...common, state: 'repairable',
        summary: 'A signed managed update is required before Codex can be authorized.' },
        operation };
    }
    return { check: { ...common, state: 'authorization-required',
      summary: 'The managed Codex runtime is installed, but Codex authorization is required.' },
      operation };
  }
  if (capabilities.includes(codexRuntimeCapability)) {
    return { check: { ...common, state: 'uncertain',
      summary: 'The managed Codex runtime is available, but its account status is uncertain.' },
      operation };
  }
  if (action) {
    if (!canRepair) {
      return { check: { ...common, state: 'authorization-required',
        summary: 'Only the machine owner may authorize this managed repair.' },
        operation };
    }
    if (update?.availableCapabilities?.includes(codexRuntimeCapability)) {
      return { action, check: { ...common, state: 'repairable',
        summary: 'A signed managed update can install the Codex runtime.' }, operation };
    }
    return { action, check: { ...common, state: 'manually-blocked',
      summary: 'The connector can be maintained safely, but no managed Codex installation is available.' },
      operation };
  }
  if (update?.state === 'updating' || update?.state === 'restarting') {
    return { check: { ...common, state: 'repairing',
      summary: 'A managed connector repair is in progress.' }, operation };
  }
  if (update?.state === 'rollback') {
    return { check: { ...common, state: 'rolling-back',
      summary: 'The managed connector update is rolling back.' }, operation };
  }
  if (update?.state === 'failed') {
    return { check: { ...common, state: 'failed',
      summary: 'Managed connector maintenance failed.' }, operation };
  }
  if (update?.state === 'unknown') {
    return { check: { ...common, state: 'uncertain',
      summary: 'The approved managed release could not be established.' }, operation };
  }
  if (runtime?.source === 'managed' && !runtimeStatus) {
    return { check: { ...common, state: 'uncertain',
      summary: 'Managed connector release status is unavailable.' }, operation };
  }
  if (runtime?.source === 'managed') {
    return { check: { ...common, state: 'manually-blocked',
      summary: 'Codex is missing and no signed managed Codex installation is available.' },
      operation };
  }
  return { check: { ...common, state: 'unsupported',
    summary: 'This connector is not eligible for safe managed repair.' }, operation };
}

function repairAction(
  connectorId: string,
  status: MachineRuntimeStatusResult | undefined
): MachineReadinessRepairAction | undefined {
  const update = status?.update;
  if (!update) return undefined;
  if (update.state === 'restart-required' &&
      status.capabilities.includes('runtime.restart')) {
    return {
      connectorId,
      fromVersion: status.runtime?.version,
      kind: 'restart-connector',
      operation: 'restart',
      summary: 'Restart the managed connector through its constrained maintenance channel.'
    };
  }
  if ((update.state !== 'update-available' && update.state !== 'update-required') ||
      !update.availableReleaseId) return undefined;
  return {
    connectorId,
    fromVersion: status.runtime?.version,
    kind: 'update-connector',
    operation: 'update',
    releaseId: update.availableReleaseId,
    summary: `Install signed managed connector release ${update.availableReleaseId}.`,
    toVersion: update.availableVersion
  };
}

function selectedResult(
  machine: PhysicalMachineRecord,
  checkedAt: string,
  checks: MachineReadinessCheck[],
  selected: EvaluatedCheck,
  state: MachineReadinessState,
  message: string
): MachineReadinessResult {
  const action = selected.action;
  const plan = action ? { actions: [action], id: planId(machine.id, action) } : undefined;
  const result = resultFor(machine, checkedAt, checks, state, message);
  const command = `project doctor --machine-id ${machine.id} --connector ${selected.check.connectorId}`;
  return {
    ...result,
    ...(selected.operation ? { operation: selected.operation } : {}),
    ...(plan ? { plan } : {}),
    nextAction: state === 'authorization-required'
      ? {
          command: `project codex login --machine-id ${machine.id} --connector ${selected.check.connectorId}`,
          kind: 'supported-action',
          message: 'Authorize the managed Codex runtime with a device code.'
        }
      : plan
      ? {
          command: `${command} --fix`,
          kind: 'doctor-fix',
          message: state === 'manually-blocked'
            ? 'Doctor can maintain the managed connector, but no supported repair can install Codex.'
            : 'Review and confirm the exact managed repair plan.'
        }
      : result.nextAction.command
        ? { ...result.nextAction, command }
        : result.nextAction,
    selectedConnectorId: selected.check.connectorId
  };
}

function resultFor(
  machine: PhysicalMachineRecord,
  checkedAt: string,
  checks: MachineReadinessCheck[],
  state: MachineReadinessState,
  message: string
): MachineReadinessResult {
  const command = `project doctor --machine-id ${machine.id}`;
  const fixable = state === 'repairable' || state === 'degraded';
  const ready = state === 'ready' || state === 'degraded' || state === 'repaired';
  return {
    apiVersion: MACHINE_READINESS_API_VERSION,
    checkedAt,
    checks,
    machine: { id: machine.id, name: machine.name },
    message,
    nextAction: state === 'authorization-required'
      ? {
          command: `project codex login --machine-id ${machine.id}`,
          kind: 'supported-action',
          message: 'Authorize the managed Codex runtime with a device code.'
        }
      : ready && !fixable
      ? { kind: 'none', message: 'No action is required.' }
      : fixable
        ? { command: `${command} --fix`, kind: 'doctor-fix',
            message: 'Review and confirm the exact managed repair plan.' }
        : state === 'repairing' || state === 'rolling-back'
          ? { command, kind: 'wait', message: 'Wait, then run Doctor again.' }
          : { command, kind: 'doctor',
              message: 'Use Project Doctor for the current supported status and next action.' },
    ready,
    state
  };
}

function baseResult(input: {
  checkedAt: string;
  machine?: PhysicalMachineRecord;
  message: string;
  state: MachineReadinessState;
}): MachineReadinessResult {
  return {
    apiVersion: MACHINE_READINESS_API_VERSION,
    checkedAt: input.checkedAt,
    checks: [],
    ...(input.machine ? { machine: { id: input.machine.id, name: input.machine.name } } : {}),
    message: input.message,
    nextAction: {
      kind: input.state === 'unauthorized' ? 'contact-owner' : 'doctor',
      message: input.message
    },
    ready: false,
    state: input.state
  };
}

function planId(machineId: string, action: MachineReadinessRepairAction) {
  return createHash('sha256').update(JSON.stringify({
    action: {
      connectorId: action.connectorId,
      fromVersion: action.fromVersion ?? null,
      kind: action.kind,
      operation: action.operation,
      releaseId: action.releaseId ?? null,
      toVersion: action.toVersion ?? null
    },
    machineId,
    schema: 'project-space.machine-readiness-plan/v1'
  })).digest('hex');
}
