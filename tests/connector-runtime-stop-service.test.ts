import { describe, expect, test } from 'bun:test';

import type { MachineRecord } from '../src/shared/project-space-api';
import type { ConnectorRuntimeStopPlan } from '../server/connector-runtime-stop-contract';
import {
  ConnectorRuntimeStopService,
  parseConnectorRuntimeStopBrowserRequest
} from '../server/connector-runtime-stop-service';

function machine(overrides: {
  capabilities?: string[];
  channel?: 'stable' | 'beta' | 'dev';
  name?: string;
  platform?: 'darwin' | 'linux' | 'windows';
  profile?: boolean;
  source?: 'managed' | 'homebrew' | 'winget' | 'source' | 'legacy' | 'unknown';
  status?: 'local' | 'online' | 'offline';
} = {}): MachineRecord {
  const platform = overrides.platform ?? 'linux';
  return {
    connector: {
      capabilities: overrides.capabilities ?? ['runtime.stop'],
      installCommand: 'project-space-connector',
      lastSeen: '2026-07-15T00:00:00.000Z',
      ...(overrides.profile === false ? {} : {
        profile: { channel: 'dev' as const, source: 'source' as const }
      }),
      runtime: {
        architecture: platform === 'darwin' ? 'arm64' : 'x64',
        buildId: 'c'.repeat(40),
        bundleVersions: {
          connector: '0.4.7',
          machineTools: '0.4.7',
          projectCli: '0.4.7'
        },
        channel: overrides.channel ?? 'dev',
        instanceId: 'instance-source-dev',
        lastCheckedAt: '2026-07-15T00:00:00.000Z',
        platform,
        protocolVersion: '2',
        releaseId: `dev-source-${'c'.repeat(40)}`,
        source: overrides.source ?? 'source',
        version: '0.4.7'
      },
      serviceName: 'project-space-connector-dev',
      status: overrides.status ?? 'online',
      update: { state: 'unsupported' }
    },
    id: 'machine-dev',
    kind: 'connector',
    name: overrides.name ?? 'Ordinary workstation',
    network: {},
    primaryUser: 'oli',
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function harness(input: {
  machine?: MachineRecord | null;
  role?: 'member' | 'owner' | null;
} = {}) {
  const plans: ConnectorRuntimeStopPlan[] = [];
  const selected = input.machine === undefined ? machine() : input.machine;
  const service = new ConnectorRuntimeStopService({
    directory: {
      async readMachine() {
        return selected;
      },
      async readMembership() {
        return input.role === undefined ? { role: 'owner' } :
          input.role === null ? null : { role: input.role };
      }
    },
    dispatcher: {
      async dispatch({ plan }) {
        plans.push(plan);
        return {
          binding: {
            generation: 7,
            instanceId: plan.expectedRuntime.instanceId,
            machineId: plan.machineId,
            operationId: plan.operationId,
            planSha256: 'd'.repeat(64)
          },
          status: 'accepted'
        };
      }
    },
    operationId: () => 'operation-source-stop'
  });
  return { plans, service };
}

describe('connector runtime stop service', () => {
  test('accepts only an exact browser request and returns the acknowledged operation', async () => {
    expect(parseConnectorRuntimeStopBrowserRequest({ machineId: 'machine-dev' }))
      .toEqual({ machineId: 'machine-dev' });
    expect(() => parseConnectorRuntimeStopBrowserRequest({
      machineId: 'machine-dev',
      pid: 42
    })).toThrow(expect.objectContaining({ code: 'invalid-request' }));

    const { plans, service } = harness();
    await expect(service.request({ machineId: 'machine-dev' }, 'user-owner')).resolves.toEqual({
      operationId: 'operation-source-stop',
      status: 'accepted'
    });
    expect(plans).toEqual([expect.objectContaining({
      expectedRuntime: expect.objectContaining({
        channel: 'dev',
        instanceId: 'instance-source-dev',
        source: 'source'
      }),
      machineId: 'machine-dev',
      operation: 'stop',
      target: 'linux-x64'
    })]);
  });

  test('uses explicit runtime metadata and never infers development from the name', async () => {
    const misleading = harness({
      machine: machine({ name: 'dev-box', profile: false })
    });
    await expect(misleading.service.request({ machineId: 'machine-dev' }, 'user-owner'))
      .rejects.toMatchObject({ code: 'unsupported-operation' });
    expect(misleading.plans).toHaveLength(0);

    const explicit = harness({ machine: machine({
      channel: 'stable',
      name: 'Production-looking workstation',
      source: 'managed'
    }) });
    await expect(explicit.service.request({ machineId: 'machine-dev' }, 'user-owner'))
      .resolves.toMatchObject({ status: 'accepted' });
  });

  test('requires owner membership, online state, and the dedicated capability', async () => {
    await expect(harness({ role: 'member' }).service.request(
      { machineId: 'machine-dev' }, 'user-member'
    )).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(harness({ machine: machine({ status: 'offline' }) }).service.request(
      { machineId: 'machine-dev' }, 'user-owner'
    )).rejects.toMatchObject({ code: 'offline' });
    await expect(harness({ machine: machine({ capabilities: [] }) }).service.request(
      { machineId: 'machine-dev' }, 'user-owner'
    )).rejects.toMatchObject({ code: 'unsupported-operation' });
  });

  test('rejects native Windows source execution and mismatched acknowledgements', async () => {
    await expect(harness({ machine: machine({ platform: 'windows' }) }).service.request(
      { machineId: 'machine-dev' }, 'user-owner'
    )).rejects.toMatchObject({ code: 'unsupported-platform' });

    const selected = machine();
    const service = new ConnectorRuntimeStopService({
      directory: {
        async readMachine() { return selected; },
        async readMembership() { return { role: 'owner' }; }
      },
      dispatcher: {
        async dispatch({ plan }) {
          return {
            binding: {
              generation: 7,
              instanceId: 'instance-other',
              machineId: plan.machineId,
              operationId: plan.operationId,
              planSha256: 'e'.repeat(64)
            },
            status: 'accepted'
          };
        }
      },
      operationId: () => 'operation-source-stop'
    });
    await expect(service.request({ machineId: 'machine-dev' }, 'user-owner'))
      .rejects.toMatchObject({ code: 'outcome-unknown' });
  });
});
