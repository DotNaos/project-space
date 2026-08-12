import { createHash } from 'node:crypto';

import type { MachinePowerOperationResult } from '../../src/shared/machine-power-api';
import type { MachinePowerHttpService } from '../machine-power/http';
import { HostControlError, type HostControlProvider } from './contracts';

export function createMachinePowerHostControlProvider(
  service: MachinePowerHttpService
): HostControlProvider {
  return {
    async status(binding) {
      const machineId = binding.machinePower?.physicalMachineId;
      if (!machineId) throw unavailable();
      const status = await service.status(
        { userId: binding.ownerUserId },
        { physicalMachineId: machineId }
      );
      return {
        ...binding.capabilities,
        available: status.state === 'online' || status.state === 'offline',
        ...(status.evidence?.checkedAt ? { lastVerifiedAt: status.evidence.checkedAt } : {}),
        powerState: status.evidence?.physicalPower === true
          ? 'on' as const : status.evidence?.physicalPower === false ? 'off' as const : 'unknown' as const
      };
    },
    async power(binding, state, context) {
      const machineId = binding.machinePower?.physicalMachineId;
      if (!machineId || state !== 'on') throw unavailable();
      const result = await service.request(context.actor, {
        operationId: `host-control:${createHash('sha256').update(context.operationId).digest('hex')}`,
        physicalMachineId: machineId,
        requestedState: state
      });
      return powerOutcome(result);
    },
    async screenshot() { throw unavailable(); },
    async input() { throw unavailable(); }
  };
}

function powerOutcome(result: MachinePowerOperationResult) {
  if (result.state === 'confirmed-online') return 'completed' as const;
  if (result.state === 'accepted' || result.state === 'uncertain') return 'uncertain' as const;
  throw unavailable();
}

function unavailable() {
  return new HostControlError('capability_unavailable', 'The configured Host provider does not support this action.');
}
