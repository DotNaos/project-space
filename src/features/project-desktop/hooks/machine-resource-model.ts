import {
  MACHINE_RESOURCES_API_VERSION,
  MACHINE_RESOURCES_STALE_AFTER_MS,
  type MachineResourceMetric,
  type MachineResourceRecord
} from '../../../shared/machine-resources-api';
import type { ConnectorOverviewResult } from '@/shared/project-space-api';

export function mergeMachineResources(
  overview: ConnectorOverviewResult,
  resources: readonly MachineResourceRecord[]
): ConnectorOverviewResult {
  const byConnectorId = new Map(resources.map((record) => [record.connectorId, record]));

  return {
    ...overview,
    machines: overview.machines.map((machine) => ({
      ...machine,
      resources: byConnectorId.get(machine.id)
    }))
  };
}

export function preserveMachineResources(
  next: ConnectorOverviewResult,
  current: ConnectorOverviewResult
) {
  return mergeMachineResources(
    next,
    current.machines.flatMap((machine) => machine.resources ? [machine.resources] : [])
  );
}

function unavailableMetric(): MachineResourceMetric {
  return {
    message: 'Current resource usage could not be loaded.',
    state: 'failed'
  };
}

export function markMachineResourcesUnavailable(
  overview: ConnectorOverviewResult,
  checkedAtMs = Date.now()
): ConnectorOverviewResult {
  return {
    ...overview,
    machines: overview.machines.map((machine) => {
      const current = machine.resources;
      if (current) {
        const receivedAtMs = current.receivedAt ? Date.parse(current.receivedAt) : Number.NaN;
        const shouldBeStale =
          (current.state === 'live' || current.state === 'partial') &&
          (!Number.isFinite(receivedAtMs) ||
            checkedAtMs - receivedAtMs > MACHINE_RESOURCES_STALE_AFTER_MS);
        return {
          ...machine,
          resources: shouldBeStale ? { ...current, state: 'stale' } : current
        };
      }

      return {
        ...machine,
        resources: {
          apiVersion: MACHINE_RESOURCES_API_VERSION,
          connectorId: machine.id,
          context: { id: machine.id },
          environment: machine.environment,
          executionScopeId: machine.executionScopeId,
          machineId: machine.id,
          machineName: machine.name,
          metrics: {
            cpu: unavailableMetric(),
            disk: unavailableMetric(),
            gpu: unavailableMetric(),
            memory: unavailableMetric()
          },
          state: 'failed'
        }
      };
    })
  };
}
