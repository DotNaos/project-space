import { describe, expect, test } from 'bun:test';

import {
  connectorRuntimeFingerprint,
  projectMachineRuntimeStatus,
  runtimeMatchesExpectedFingerprint
} from '../server/connector-runtime-status';
import { connectorRuntimeReleaseManifestSchema } from '../server/connector-runtime-release-manifest';
import type {
  ConnectorRuntimeOperationRecord,
  ConnectorRuntimeRecord,
  MachineRecord
} from '../src/shared/project-space-api';
import { canRestartMachineRuntime } from '../src/features/project-desktop/components/machine-connector-runtime-model';

const runtime: ConnectorRuntimeRecord = {
  architecture: 'arm64',
  buildId: '0'.repeat(40),
  bundleVersions: { connector: '0.4.0', machineTools: '0.4.0', projectCli: '0.4.0' },
  channel: 'stable',
  instanceId: 'instance-before',
  lastCheckedAt: '2026-07-14T00:00:00.000Z',
  platform: 'darwin',
  protocolVersion: '2',
  releaseId: 'v0.4.0',
  source: 'managed',
  version: '0.4.0'
};
const capabilities = ['runtime.restart', 'runtime.update', 'worktrees.list.v2'];

function machine(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    connector: {
      capabilities,
      installCommand: 'project-space-connector',
      runtime,
      status: 'online'
    },
    id: 'machine-1',
    kind: 'connector',
    name: 'Machine',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub',
    ...overrides
  };
}

const approved = {
  artifact: {
    assetName: 'project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
    bundleVersions: { connector: '0.5.0', machineTools: '0.5.0', projectCli: '0.5.0' },
    capabilities,
    downloadUrl:
      'https://github.com/DotNaos/project-space/releases/download/v0.5.0/project-space-machine-tools-darwin-arm64-v0.5.0.tar.gz',
    protocolVersion: '2',
    sha256: 'a'.repeat(64),
    sizeBytes: 4,
    target: 'darwin-arm64' as const
  },
  checkedAt: '2026-07-14T00:01:00.000Z',
  manifest: {
    artifacts: [],
    buildId: '1'.repeat(40),
    channel: 'stable' as const,
    expiresAt: '2027-07-14T00:00:00.000Z',
    issuedAt: '2026-07-14T00:00:00.000Z',
    releaseId: 'v0.5.0',
    schema: connectorRuntimeReleaseManifestSchema,
    source: 'managed' as const,
    version: '0.5.0'
  }
};

function operation(state: ConnectorRuntimeOperationRecord['state']): ConnectorRuntimeOperationRecord {
  return {
    createdAt: '2026-07-14T00:00:00.000Z',
    id: 'operation-1',
    machineId: 'machine-1',
    operation: 'update',
    requestedByUserId: 'owner',
    state,
    updatedAt: '2026-07-14T00:00:01.000Z'
  };
}

describe('connector runtime status', () => {
  test('does not claim a metadata-less or capability-less connector can update itself', () => {
    expect(projectMachineRuntimeStatus({ machine: machine({
      connector: { capabilities, installCommand: 'legacy', status: 'online' }
    }) }).update.state).toBe('unsupported');
    expect(projectMachineRuntimeStatus({ machine: machine({
      connector: { capabilities: [], installCommand: 'legacy', runtime, status: 'online' }
    }), approved }).update.state).toBe('unsupported');
  });

  test('keeps restart independent when this connector cannot self-update', () => {
    const restartOnly = machine({ connector: {
      capabilities: ['runtime.restart'],
      installCommand: 'connector',
      runtime,
      status: 'online'
    } });
    const status = projectMachineRuntimeStatus({ approved, machine: restartOnly });
    expect(status.update.state).toBe('unsupported');
    expect(canRestartMachineRuntime({
      ...restartOnly,
      connector: { ...restartOnly.connector, update: status.update }
    })).toBe(true);
  });

  test('keeps the shipped Windows runtime honestly unsupported', () => {
    const windows = machine({ connector: {
      capabilities: ['runtime.restart', 'runtime.update'],
      installCommand: 'project.exe',
      runtime: { ...runtime, architecture: 'x64', platform: 'windows' },
      status: 'online'
    } });
    expect(projectMachineRuntimeStatus({ approved, machine: windows }).update.state)
      .toBe('unsupported');
  });

  test('preserves operation progress across the temporary disconnect', () => {
    const result = projectMachineRuntimeStatus({
      approved,
      machine: machine({ connector: {
        capabilities, installCommand: 'connector', runtime, status: 'offline'
      } }),
      operation: operation('reconnecting')
    });
    expect(result.online).toBe(false);
    expect(result.update.state).toBe('updating');
    expect(result.update.operation?.state).toBe('reconnecting');
  });

  test('distinguishes required compatibility updates, optional updates, and current builds', () => {
    expect(projectMachineRuntimeStatus({ approved, machine: machine() }).update.state)
      .toBe('update-available');
    expect(projectMachineRuntimeStatus({
      approved: { ...approved, artifact: { ...approved.artifact, protocolVersion: '3' } },
      machine: machine()
    }).update.state).toBe('update-required');
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine({ connector: {
        capabilities,
        installCommand: 'connector',
        runtime: {
          ...runtime,
          buildId: approved.manifest.buildId,
          bundleVersions: { connector: '0.5.0', machineTools: '0.5.0', projectCli: '0.5.0' },
          releaseId: 'v0.5.0',
          version: '0.5.0'
        },
        status: 'online'
      } })
    }).update.state).toBe('up-to-date');
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine({ connector: {
        capabilities,
        installCommand: 'connector',
        runtime: {
          ...runtime,
          buildId: approved.manifest.buildId,
          bundleVersions: { connector: '0.5.0', machineTools: '0.4.0', projectCli: '0.5.0' },
          releaseId: 'v0.5.0',
          version: '0.5.0'
        },
        status: 'online'
      } })
    }).update.state).toBe('update-available');
  });

  test('requires a new instance and the exact expected reconnect evidence', () => {
    const nextBundle = {
      connector: '0.5.0', machineTools: '0.5.0', projectCli: '0.5.0'
    };
    const expected = connectorRuntimeFingerprint(
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'ignored', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities
    );
    expect(runtimeMatchesExpectedFingerprint(
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'instance-after', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities,
      expected,
      'instance-before'
    )).toBe(true);
    expect(runtimeMatchesExpectedFingerprint(
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'instance-before', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities,
      expected,
      'instance-before'
    )).toBe(false);
    expect(runtimeMatchesExpectedFingerprint(
      { ...runtime, buildId: 'f'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'instance-after', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities,
      expected,
      'instance-before'
    )).toBe(false);
    expect(runtimeMatchesExpectedFingerprint(
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'instance-after', releaseId: 'v0.5.0', version: '0.4.0' },
      capabilities,
      expected,
      'instance-before'
    )).toBe(false);
    expect(runtimeMatchesExpectedFingerprint(
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: {
          ...nextBundle, machineTools: '0.4.0'
        }, instanceId: 'instance-after', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities,
      expected,
      'instance-before'
    )).toBe(false);
  });
});
