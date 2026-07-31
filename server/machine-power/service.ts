import { createHash } from 'node:crypto';

import {
  MACHINE_POWER_API_VERSION,
  type MachinePowerOperationResult,
  type MachinePowerRequest,
  type MachinePowerSelector,
  type MachinePowerStatusResult
} from '../../src/shared/machine-power-api';
import type { PhysicalMachineRecord } from '../../src/shared/project-space-api';
import type { JetKvmMqttBinding } from './config';
import {
  MachinePowerProviderError,
  firmwareMatches,
  type MachinePowerProvider
} from './provider';
import type {
  MachinePowerOperationStore,
  MachinePowerReservation
} from './store';

export type MachinePowerServiceErrorCode =
  | 'ambiguous-machine'
  | 'idempotency-conflict'
  | 'invalid-request'
  | 'unauthorized';

export class MachinePowerServiceError extends Error {
  constructor(readonly code: MachinePowerServiceErrorCode, message: string) {
    super(message);
    this.name = 'MachinePowerServiceError';
  }
}

export interface MachinePowerServiceOptions {
  bindings(): Promise<JetKvmMqttBinding[]>;
  inventory(userId: string): Promise<PhysicalMachineRecord[]>;
  operations: MachinePowerOperationStore;
  provider: MachinePowerProvider;
}

export interface MachinePowerActor {
  callerMachineId?: string;
  userId: string;
}

export function createMachinePowerService(options: MachinePowerServiceOptions) {
  async function resolveTarget(actor: MachinePowerActor, selector: MachinePowerSelector) {
    if (!actor.userId) {
      throw new MachinePowerServiceError('unauthorized', 'Authentication is required.');
    }
    const machines = (await options.inventory(actor.userId)).filter((machine) =>
      selector.physicalMachineId
        ? machine.id === selector.physicalMachineId
        : selector.physicalMachineName
          ? machine.name === selector.physicalMachineName
          : false
    );
    if (machines.length !== 1) {
      throw new MachinePowerServiceError(
        'ambiguous-machine',
        machines.length === 0
          ? 'The exact managed machine was not found for this account.'
          : 'The machine name is ambiguous; select it by ID.'
      );
    }
    const machine = machines[0]!;
    if (machine.kind !== 'physical') {
      return { binding: undefined, machine };
    }
    const bindings = (await options.bindings()).filter(
      (binding) => binding.machine.ownerUserId === actor.userId &&
        binding.machine.physicalMachineId === machine.id &&
        binding.machine.selector === machine.name
    );
    if (bindings.length > 1) {
      throw new MachinePowerServiceError(
        'ambiguous-machine',
        'More than one power provider is configured for this machine.'
      );
    }
    return { binding: bindings[0], machine };
  }

  return {
    async status(
      actor: MachinePowerActor,
      selector: MachinePowerSelector
    ): Promise<MachinePowerStatusResult> {
      const { binding, machine } = await resolveTarget(actor, selector);
      if (!binding) return unsupportedStatus(machine);
      let evidence;
      try {
        evidence = await options.provider.probe(binding);
      } catch {
        return statusResult(machine, binding, 'failed', undefined,
          'The JetKVM MQTT provider is unavailable.');
      }
      if (evidence.jetKvmOnline === false) {
        return statusResult(machine, binding, 'failed', evidence,
          'JetKVM is not connected to the managed broker.');
      }
      if (!evidence.fresh || evidence.physicalPower === undefined) {
        return statusResult(machine, binding, 'unknown', evidence,
          'JetKVM is reachable, but fresh physical power evidence is unavailable.');
      }
      if (!evidence.firmwareVersion) {
        return statusResult(machine, binding, 'unknown', evidence,
          'JetKVM is reachable, but its firmware version was not confirmed.');
      }
      if (!firmwareMatches(
        binding.provider.firmwareCompatibility, evidence.firmwareVersion
      )) {
        return statusResult(machine, binding, 'unsupported', evidence,
          'The installed JetKVM firmware is not approved for this power provider.');
      }
      if (evidence.physicalPower) {
        try {
          await options.operations.reconcileOnline(
            actor.userId, machine.id, evidence
          );
        } catch {
          return statusResult(
            machine, binding, 'online', evidence,
            'JetKVM confirms power, but operation reconciliation could not be recorded.',
            { state: 'failed' }
          );
        }
      }
      return statusResult(
        machine,
        binding,
        evidence.physicalPower ? 'online' : 'offline',
        evidence,
        evidence.physicalPower
          ? 'JetKVM confirms that the physical machine has power.'
          : 'JetKVM confirms that the physical machine is switched off.',
        evidence.physicalPower ? { state: 'complete' } : undefined
      );
    },

    async request(
      actor: MachinePowerActor,
      request: MachinePowerRequest
    ): Promise<MachinePowerOperationResult> {
      const { binding, machine } = await resolveTarget(actor, request);
      const reservation = reserveInput(actor, machine.id, request);
      const reserved = await options.operations.reserve(reservation);
      if (reserved.kind === 'replayed') return reserved.result;
      if (reserved.kind === 'conflict') {
        throw new MachinePowerServiceError(
          'idempotency-conflict',
          'The operation ID was already used for a different power request.'
        );
      }
      if (reserved.kind === 'fenced' || reserved.kind === 'uncertain') {
        return operationResult(machine, binding, request, 'uncertain',
          'A power request may already be in flight. It was not sent again.');
      }

      if (!binding) {
        return finish(options.operations, reservation,
          operationResult(machine, undefined, request, 'unsupported',
            'This machine has no managed power provider.'));
      }
      if (request.requestedState === 'off') {
        return finish(options.operations, reservation,
          operationResult(machine, binding, request, 'unsupported',
            'Forced power-off is not enabled. Use the managed operating-system shutdown path.'));
      }

      let providerResult;
      try {
        providerResult = await options.provider.requestPowerOn(binding);
      } catch (error) {
        if (error instanceof MachinePowerProviderError && error.stage === 'preflight') {
          return finish(options.operations, reservation,
            operationResult(machine, binding, request, 'failed',
              'The JetKVM MQTT provider could not complete a safe preflight.'));
        }
        const uncertain = operationResult(
          machine, binding, request, 'uncertain',
          'One delivery attempt may have been made. Broker receipt and physical state are not confirmed.',
          undefined, true
        );
        return finish(options.operations, reservation, uncertain);
      }
      const evidence = providerResult.evidence;
      if (!evidence.fresh || evidence.jetKvmOnline !== true ||
          evidence.physicalPower === undefined) {
        return finish(options.operations, reservation,
          operationResult(machine, binding, request, 'uncertain',
            'Fresh JetKVM and physical power evidence is required before a toggle.', evidence));
      }
      if (!evidence.firmwareVersion) {
        return finish(options.operations, reservation,
          operationResult(machine, binding, request, 'uncertain',
            'The JetKVM firmware version could not be confirmed; no command was sent.',
            evidence));
      }
      if (!firmwareMatches(
        binding.provider.firmwareCompatibility, evidence.firmwareVersion
      )) {
        return finish(options.operations, reservation,
          operationResult(machine, binding, request, 'unsupported',
            'The installed JetKVM firmware is not approved; no command was sent.',
            evidence));
      }
      if (evidence.physicalPower) {
        return finish(options.operations, reservation,
          operationResult(machine, binding, request, 'confirmed-online',
            'The machine is already powered on; no command was sent.', evidence));
      }
      if (!providerResult.attempted) {
        return finish(options.operations, reservation,
          operationResult(machine, binding, request, 'uncertain',
            'The provider did not dispatch a short ATX press.', evidence));
      }
      return finish(options.operations, reservation,
        operationResult(
          machine, binding, request, 'uncertain',
          'One QoS 0 delivery attempt was made. Broker receipt and physical state are not confirmed.',
          evidence, true
        ));
    }
  };
}

function reserveInput(
  actor: MachinePowerActor,
  machineId: string,
  request: MachinePowerRequest
): MachinePowerReservation {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([machineId, request.requestedState]))
    .digest('hex');
  return {
    actorType: actor.callerMachineId ? 'machine' : 'human',
    ...(actor.callerMachineId ? { callerMachineId: actor.callerMachineId } : {}),
    fingerprint,
    machineId,
    operationId: request.operationId,
    requestedState: request.requestedState,
    userId: actor.userId
  };
}

async function finish(
  store: MachinePowerOperationStore,
  reservation: MachinePowerReservation,
  result: MachinePowerOperationResult
) {
  try {
    await store.finish(reservation, result);
    return result;
  } catch {
    await store.markUncertain(reservation, result.dispatch.attempted)
      .catch(() => undefined);
    return { ...result, state: 'uncertain' as const,
      message: 'The outcome could not be durably recorded; the request was not retried.' };
  }
}

function unsupportedStatus(machine: PhysicalMachineRecord): MachinePowerStatusResult {
  return {
    apiVersion: MACHINE_POWER_API_VERSION,
    machine: { id: machine.id, name: machine.name },
    message: 'This machine has no managed power provider.',
    provider: { deviceId: '', kind: 'jetkvm-mqtt' },
    state: 'unsupported'
  };
}

function statusResult(
  machine: PhysicalMachineRecord,
  binding: JetKvmMqttBinding,
  state: MachinePowerStatusResult['state'],
  evidence: MachinePowerStatusResult['evidence'],
  message: string,
  reconciliation?: MachinePowerStatusResult['reconciliation']
): MachinePowerStatusResult {
  return {
    apiVersion: MACHINE_POWER_API_VERSION,
    ...(evidence ? { evidence } : {}),
    machine: { id: machine.id, name: machine.name },
    message,
    provider: { deviceId: binding.provider.deviceId, kind: binding.provider.kind },
    ...(reconciliation ? { reconciliation } : {}),
    state
  };
}

function operationResult(
  machine: PhysicalMachineRecord,
  binding: JetKvmMqttBinding | undefined,
  request: MachinePowerRequest,
  state: MachinePowerOperationResult['state'],
  message: string,
  evidence?: MachinePowerOperationResult['evidence'],
  attempted = false
): MachinePowerOperationResult {
  return {
    apiVersion: MACHINE_POWER_API_VERSION,
    dispatch: { attempted, brokerAcknowledged: false },
    ...(evidence ? { evidence } : {}),
    machine: { id: machine.id, name: machine.name },
    message,
    operationId: request.operationId,
    provider: {
      deviceId: binding?.provider.deviceId ?? '',
      kind: 'jetkvm-mqtt'
    },
    requestedState: request.requestedState,
    state
  };
}
