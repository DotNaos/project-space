import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  MACHINE_RESOURCES_API_VERSION,
  MACHINE_RESOURCES_STALE_AFTER_MS,
  type MachineResourceAvailability,
  type MachineResourceMetric,
  type MachineResourceRecord,
  type MachineResourcesResult
} from '../src/shared/machine-resources-api';
import type {
  MachineRecord,
  PhysicalMachineRecord,
  ProjectSpaceBackend
} from '../src/shared/project-space-api';
import { CodexMachineTasksAuthError } from './codex-machine-tasks/auth-context';
import {
  isDatabaseConfigured,
  listPhysicalMachines
} from './local-database-store';
import {
  isProjectSpaceAuthRequired,
  readAuthSessionFromRequest,
  runWithAuthSession
} from './local-auth-store';
import type { MachineConnectionRuntime } from './machine-connection-runtime';
import { latestMachineResourceSnapshot } from './machine-resource-store';
import { writeJson } from './project-space-http-response';
import { createCodexMachineTasksAuthResolver } from './codex-machine-tasks/auth-context';

const route = '/api/machine-resources';
export interface ConfiguredMachineResourcesOptions {
  backend: Pick<ProjectSpaceBackend, 'getConnectorOverview'>;
  machineConnection?: Pick<MachineConnectionRuntime, 'resolveMachineCredentialIdentity'>;
}

function unavailableMetric(): MachineResourceMetric {
  return {
    message: 'No resource sample has been received from this connector.',
    state: 'unsupported'
  };
}

function unavailableMetrics() {
  return {
    cpu: unavailableMetric(),
    disk: unavailableMetric(),
    gpu: unavailableMetric(),
    memory: unavailableMetric()
  };
}

function contextLabel(machine: MachineRecord) {
  const environmentKindLabels = {
    linux: 'Linux',
    macos: 'macOS',
    windows: 'Windows',
    wsl: 'WSL'
  } as const;
  const environment = machine.environment?.label ??
    (machine.environment?.kind
      ? environmentKindLabels[machine.environment.kind]
      : undefined);
  const channel = machine.connector.profile ? 'Dev' : 'Stable';
  return [environment, channel].filter(Boolean).join(' · ');
}

function physicalMachineFor(
  connectorId: string,
  physicalMachines: PhysicalMachineRecord[]
) {
  return physicalMachines.find((physical) => physical.connectorIds.includes(connectorId));
}

function snapshotState(
  machine: MachineRecord,
  record: ReturnType<typeof latestMachineResourceSnapshot>,
  checkedAtMs: number
): MachineResourceAvailability {
  if (machine.connector.status === 'offline') return 'offline';
  if (!record) return 'unsupported';
  if (checkedAtMs - Date.parse(record.receivedAt) > MACHINE_RESOURCES_STALE_AFTER_MS) {
    return 'stale';
  }
  const required = [
    record.snapshot.metrics.cpu,
    record.snapshot.metrics.memory,
    record.snapshot.metrics.disk
  ];
  const available = required.filter((metric) => metric.state === 'available').length;
  if (available === 0) {
    return required.every((metric) => metric.state === 'unsupported') ? 'unsupported' : 'failed';
  }
  if (
    available !== required.length ||
    record.snapshot.metrics.gpu.state === 'failed'
  ) {
    return 'partial';
  }
  return 'live';
}

function resourceRecord(
  machine: MachineRecord,
  physicalMachines: PhysicalMachineRecord[],
  checkedAtMs: number
): MachineResourceRecord {
  const stored = latestMachineResourceSnapshot(machine.id);
  const physical = physicalMachineFor(machine.id, physicalMachines);
  const snapshot = stored?.snapshot;
  return {
    apiVersion: MACHINE_RESOURCES_API_VERSION,
    connectorId: machine.id,
    context: {
      id: machine.id,
      label: contextLabel(machine)
    },
    environment: machine.environment,
    executionScopeId: machine.executionScopeId,
    machineId: machine.id,
    machineName: machine.name,
    metrics: snapshot?.metrics ?? unavailableMetrics(),
    physicalMachineId: physical?.id,
    physicalMachineName: physical?.name,
    receivedAt: stored?.receivedAt,
    sampledAt: snapshot?.sampledAt,
    state: snapshotState(machine, stored, checkedAtMs)
  };
}

async function listResources(
  options: ConfiguredMachineResourcesOptions,
  userId: string
): Promise<MachineResourcesResult> {
  const checkedAt = new Date().toISOString();
  const [overview, physicalMachines] = await runWithAuthSession(
    { login: 'project-cli', role: 'user', userId },
    async () => Promise.all([
      options.backend.getConnectorOverview(),
      isDatabaseConfigured() ? listPhysicalMachines(userId) : Promise.resolve([])
    ])
  );
  return {
    checkedAt,
    machines: overview.machines.map((machine) =>
      resourceRecord(machine, physicalMachines, Date.parse(checkedAt))
    )
  };
}

export function createConfiguredMachineResourcesHandler(
  options: ConfiguredMachineResourcesOptions
) {
  const resolveActor = createCodexMachineTasksAuthResolver({
    authenticateMachine: async ({ machineId, token }) => (
      options.machineConnection?.resolveMachineCredentialIdentity(token, machineId) ?? null
    ),
    authRequired: isProjectSpaceAuthRequired,
    readHuman: async (request) => {
      const session = await readAuthSessionFromRequest(request);
      return session ? { userId: session.userId } : null;
    }
  });

  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (url.pathname !== route) return false;
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method !== 'GET') {
      writeJson(response, 405, {
        error: { code: 'method_not_allowed', message: 'Method not allowed.' }
      });
      return true;
    }
    try {
      const actor = await resolveActor(request);
      writeJson(response, 200, await listResources(options, actor.userId));
    } catch (error) {
      if (error instanceof CodexMachineTasksAuthError) {
        writeJson(response, error.statusCode, {
          error: { code: 'authentication_failed', message: error.message }
        });
      } else {
        writeJson(response, 503, {
          error: {
            code: 'machine_resources_unavailable',
            message: 'Machine resources are temporarily unavailable.'
          }
        });
      }
    }
    return true;
  };
}
