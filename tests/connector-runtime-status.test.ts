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
  test('does not claim a metadata-less connector can update itself', () => {
    expect(projectMachineRuntimeStatus({ machine: machine({
      connector: { capabilities, installCommand: 'legacy', status: 'online' }
    }) }).update.state).toBe('unsupported');
  });

  test('keeps a stale managed connector visible when it has no update command', () => {
    expect(projectMachineRuntimeStatus({ machine: machine({
      connector: { capabilities: [], installCommand: 'legacy', runtime, status: 'online' }
    }), approved }).update).toMatchObject({
      availableReleaseId: 'v0.5.0',
      availableVersion: '0.5.0',
      state: 'update-required'
    });
    expect(projectMachineRuntimeStatus({ machine: machine({
      connector: { capabilities: [], installCommand: 'legacy', runtime, status: 'offline' }
    }), approved })).toMatchObject({
      online: false,
      update: { state: 'update-required' }
    });
  });

  test('keeps restart independent when this connector cannot self-update', () => {
    const restartOnly = machine({ connector: {
      capabilities: ['runtime.restart'],
      installCommand: 'connector',
      runtime,
      status: 'online'
    } });
    const status = projectMachineRuntimeStatus({ approved, machine: restartOnly });
    expect(status.update.state).toBe('update-required');
    expect(canRestartMachineRuntime({
      ...restartOnly,
      connector: { ...restartOnly.connector, update: status.update }
    })).toBe(true);
    expect(status.capabilities).not.toContain('runtime.update');
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

  test('keeps stale offline connectors and deferred updates visible', () => {
    const offline = machine({ connector: {
      capabilities, installCommand: 'connector', runtime, status: 'offline'
    } });
    expect(projectMachineRuntimeStatus({ approved, machine: offline }).update)
      .toMatchObject({
        availableVersion: '0.5.0',
        state: 'update-available'
      });
    expect(projectMachineRuntimeStatus({
      approved,
      machine: offline,
      operation: operation('queued')
    }).update.state).toBe('update-pending');
  });

  test('distinguishes required compatibility updates, optional updates, and current builds', () => {
    expect(projectMachineRuntimeStatus({ approved, machine: machine() }).update)
      .toMatchObject({
        availableCapabilities: capabilities.slice().sort(),
        state: 'update-available'
      });
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

  test('does not present an older approved release as an update', () => {
    const newerMachine = machine({ connector: {
      capabilities,
      installCommand: 'connector',
      runtime: {
        ...runtime,
        buildId: '2'.repeat(40),
        bundleVersions: {
          connector: '0.6.0', machineTools: '0.6.0', projectCli: '0.6.0'
        },
        releaseId: 'v0.6.0',
        version: '0.6.0'
      },
      status: 'online'
    } });

    const status = projectMachineRuntimeStatus({ approved, machine: newerMachine });
    expect(status.update).toMatchObject({
      availableReleaseId: 'v0.5.0',
      availableVersion: '0.5.0',
      state: 'unsupported'
    });
    expect(projectMachineRuntimeStatus({
      approved,
      machine: newerMachine,
      operation: operation('rolled-back')
    }).update.state).toBe('rollback');
  });

  test('offers a newer signed release again after a completed rollback', () => {
    const status = projectMachineRuntimeStatus({
      approved,
      machine: machine(),
      operation: {
        ...operation('rolled-back'),
        expectedBuildId: '0'.repeat(40),
        expectedReleaseId: 'v0.4.1'
      }
    });

    expect(status.update).toMatchObject({
      availableReleaseId: 'v0.5.0',
      operation: { id: 'operation-1', state: 'rolled-back' },
      state: 'update-available'
    });
  });

  test('accepts an exact signed target that becomes healthy after rollback', () => {
    const recoveredRuntime = {
      ...runtime,
      buildId: approved.manifest.buildId,
      bundleVersions: { ...approved.artifact.bundleVersions },
      releaseId: approved.manifest.releaseId,
      version: approved.manifest.version
    };
    const recoveredOperation = {
      ...operation('rolled-back'),
      expectedBuildId: approved.manifest.buildId,
      expectedFingerprint: connectorRuntimeFingerprint(
        recoveredRuntime,
        approved.artifact.capabilities
      ),
      expectedReleaseId: approved.manifest.releaseId,
      previousFingerprint: connectorRuntimeFingerprint(runtime, capabilities),
      previousInstanceId: runtime.instanceId
    };

    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine({ connector: {
        capabilities,
        installCommand: 'connector',
        runtime: recoveredRuntime,
        status: 'online'
      } }),
      operation: recoveredOperation
    }).update).toMatchObject({
      operation: { id: 'operation-1', state: 'rolled-back' },
      state: 'up-to-date'
    });
  });

  test('retries only an unchanged exact target after a pre-install download failure', () => {
    const expected = connectorRuntimeFingerprint({
      ...runtime,
      buildId: approved.manifest.buildId,
      bundleVersions: approved.artifact.bundleVersions,
      releaseId: approved.manifest.releaseId,
      version: approved.manifest.version
    }, approved.artifact.capabilities);
    const failed = {
      ...operation('failed'),
      expectedBuildId: approved.manifest.buildId,
      expectedFingerprint: expected,
      expectedReleaseId: approved.manifest.releaseId,
      lastFailure: {
        at: '2026-07-14T00:00:01.000Z',
        code: 'download-failed',
        message: 'The connector could not download the signed release.',
        rollbackAvailable: false
      },
      previousFingerprint: connectorRuntimeFingerprint(runtime, capabilities),
      previousInstanceId: runtime.instanceId
    };
    expect(projectMachineRuntimeStatus({
      approved, machine: machine(), operation: failed
    }).update).toMatchObject({
      retryEvidence: 'exact-preinstall-download-failure',
      state: 'update-available'
    });
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine({ connector: {
        capabilities,
        installCommand: 'connector',
        runtime: { ...runtime, buildId: 'f'.repeat(40) },
        status: 'online'
      } }),
      operation: failed
    }).update.state).toBe('failed');
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine(),
      operation: {
        ...failed,
        lastFailure: { ...failed.lastFailure, code: 'wrong-reconnect-version' }
      }
    }).update.state).toBe('failed');
    expect(projectMachineRuntimeStatus({
      approved: {
        ...approved,
        manifest: { ...approved.manifest, buildId: '2'.repeat(40) }
      },
      machine: machine(),
      operation: failed
    }).update.state).toBe('failed');
    expect(projectMachineRuntimeStatus({
      approved: {
        artifact: {
          ...approved.artifact,
          assetName: 'project-space-machine-tools-darwin-arm64-v0.6.0.tar.gz',
          bundleVersions: {
            connector: '0.6.0', machineTools: '0.6.0', projectCli: '0.6.0'
          },
          downloadUrl:
            'https://github.com/DotNaos/project-space/releases/download/v0.6.0/project-space-machine-tools-darwin-arm64-v0.6.0.tar.gz'
        },
        checkedAt: approved.checkedAt,
        manifest: {
          ...approved.manifest,
          buildId: '2'.repeat(40),
          releaseId: 'v0.6.0',
          version: '0.6.0'
        }
      },
      machine: machine(),
      operation: failed
    }).update).toMatchObject({
      retryEvidence: 'exact-preinstall-download-failure',
      state: 'update-available'
    });
  });

  test('does not retry the same or an unidentified rolled-back release', () => {
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine(),
      operation: operation('rolled-back')
    }).update.state).toBe('rollback');
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine(),
      operation: {
        ...operation('rolled-back'),
        expectedBuildId: '0'.repeat(40),
        expectedReleaseId: approved.manifest.releaseId
      }
    }).update.state).toBe('rollback');
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine(),
      operation: {
        ...operation('rolled-back'),
        expectedBuildId: runtime.buildId,
        expectedFingerprint: connectorRuntimeFingerprint(runtime, capabilities),
        expectedReleaseId: runtime.releaseId,
        operation: 'restart'
      }
    }).update.state).toBe('rollback');
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine(),
      operation: {
        ...operation('rolled-back'),
        expectedBuildId: 'f'.repeat(40),
        expectedFingerprint: connectorRuntimeFingerprint(runtime, capabilities),
        expectedReleaseId: runtime.releaseId
      }
    }).update.state).toBe('rollback');
  });

  test('keeps rollback visible when a newer release is not actionable', () => {
    const rolledBack = {
      ...operation('rolled-back'),
      expectedBuildId: runtime.buildId,
      expectedReleaseId: runtime.releaseId
    };
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine({ connector: {
        capabilities, installCommand: 'connector', runtime, status: 'offline'
      } }),
      operation: rolledBack
    }).update.state).toBe('rollback');
    expect(projectMachineRuntimeStatus({
      approved,
      machine: machine({ connector: {
        capabilities,
        installCommand: 'connector',
        runtime: { ...runtime, architecture: 'x64', platform: 'windows' },
        status: 'online'
      } }),
      operation: rolledBack
    }).update.state).toBe('rollback');
  });

  test('requires exact reconnect evidence and a new instance or signed identity', () => {
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
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'instance-before', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities,
      expected,
      'instance-before',
      connectorRuntimeFingerprint(runtime, capabilities)
    )).toBe(true);
    expect(runtimeMatchesExpectedFingerprint(
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'instance-before', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities,
      expected,
      'instance-before',
      connectorRuntimeFingerprint(
        { ...runtime, buildId: '1'.repeat(40) },
        capabilities
      )
    )).toBe(false);
    expect(runtimeMatchesExpectedFingerprint(
      { ...runtime, buildId: '1'.repeat(40), bundleVersions: nextBundle,
        instanceId: 'instance-before', releaseId: 'v0.5.0', version: '0.5.0' },
      capabilities,
      expected,
      'instance-before',
      connectorRuntimeFingerprint(
        { ...runtime, releaseId: 'v0.5.0' },
        capabilities
      )
    )).toBe(false);
    expect(runtimeMatchesExpectedFingerprint(
      runtime,
      capabilities,
      connectorRuntimeFingerprint(runtime, capabilities),
      'instance-before',
      connectorRuntimeFingerprint(runtime, capabilities)
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
