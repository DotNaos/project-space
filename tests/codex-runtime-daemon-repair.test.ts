import { describe, expect, test } from 'bun:test';
import {
  mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexDaemonManager } from '../server/codex-daemon/manager';
import { inspectCodexDaemonForConnectorRuntime } from '../server/codex-daemon/runtime-maintenance';
import { connectorRuntimeSupervisorOutcomeSchema } from '../server/connector-runtime-supervisor-outcome';
import type { CodexDaemonEvidence } from '../src/shared/codex-daemon-api';

function evidence(state: CodexDaemonEvidence['state']): CodexDaemonEvidence {
  return {
    authenticated: state === 'ready',
    checkedAt: '2026-08-10T00:00:00.000Z',
    compatible: state === 'ready',
    installed: true,
    paired: false,
    reachable: state === 'ready',
    remoteControlEnabled: false,
    remoteControlState: 'disabled',
    running: true,
    state
  };
}

describe('connector runtime Codex daemon repair', () => {
  test('ensures the bundled daemon before reporting post-update reconnect evidence', async () => {
    const ready = evidence('ready');
    const calls: string[] = [];
    let inspections = 0;
    const result = await inspectCodexDaemonForConnectorRuntime({
      environment: {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'runtime-update-one',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'pending-health-check',
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      },
      manager: {
        async execute(operation, operationId) {
          calls.push(operationId);
          return { evidence: ready, operation, operationId, state: 'completed' };
        },
        async inspect() {
          inspections += 1;
          return ready;
        },
        async restoreMaintenanceSelection() {}
      }
    });

    expect(result).toBe(ready);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^connector-runtime:codex-ensure:[0-9a-f]{64}$/);
    expect(inspections).toBe(1);
  });

  test('does not accept replayed repair evidence after the daemon drifts again', async () => {
    const cachedReady = evidence('ready');
    const drifted = evidence('incompatible');
    const result = await inspectCodexDaemonForConnectorRuntime({
      environment: {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'runtime-update-replayed',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'pending-health-check',
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      },
      manager: {
        async execute(operation, operationId) {
          return { evidence: cachedReady, operation, operationId, state: 'completed' };
        },
        async inspect() { return drifted; },
        async restoreMaintenanceSelection() {}
      }
    });

    expect(result).toBe(drifted);
  });

  test('falls back to explicit fail-closed evidence when repair cannot be proven', async () => {
    const incompatible = evidence('incompatible');
    const result = await inspectCodexDaemonForConnectorRuntime({
      environment: {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'runtime-update-two',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'pending-health-check',
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      },
      manager: {
        async execute() { throw new Error('repair failed'); },
        async inspect() { return incompatible; },
        async restoreMaintenanceSelection() {}
      }
    });
    expect(result).toBe(incompatible);
  });

  test('restores the pre-update Codex selection before rolled-back reconnect evidence', async () => {
    const ready = evidence('ready');
    const calls: string[] = [];
    const result = await inspectCodexDaemonForConnectorRuntime({
      environment: {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'runtime-update-rollback',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'rolled-back',
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      },
      manager: {
        async execute() { throw new Error('unexpected ensure'); },
        async inspect() {
          calls.push('inspect');
          return ready;
        },
        async restoreMaintenanceSelection(operationId) {
          calls.push(`restore:${operationId}`);
        }
      }
    });

    expect(result).toBe(ready);
    expect(calls).toEqual(['restore:runtime-update-rollback', 'inspect']);
  });

  test('does not acknowledge rolled-back evidence when pointer restoration fails', async () => {
    await expect(inspectCodexDaemonForConnectorRuntime({
      environment: {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'runtime-update-rollback-failed',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'rolled-back',
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      },
      manager: {
        async execute() { throw new Error('unexpected ensure'); },
        async inspect() { return evidence('ready'); },
        async restoreMaintenanceSelection() {
          throw new Error('pointer restore failed');
        }
      }
    })).rejects.toThrow('pointer restore failed');
  });

  test('ensure then failed health rollback restores the previous global pointer and bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-codex-runtime-rollback-'));
    try {
      const codexHome = join(root, 'codex-home');
      const standalone = join(codexHome, 'packages', 'standalone');
      const releases = join(standalone, 'releases');
      const oldRelease = join(releases, '0.145.0-upstream');
      const oldSource = join(root, 'old-signed-codex');
      const newSource = join(root, 'new-signed-codex');
      const oldBody = '#!/bin/sh\necho codex-cli 0.145.0\n';
      const newBody = '#!/bin/sh\necho codex-cli 0.146.0\n';
      await mkdir(join(oldRelease, 'bin'), { mode: 0o700, recursive: true });
      await Promise.all([
        writeFile(join(oldRelease, 'bin', 'codex'), oldBody, { mode: 0o755 }),
        writeFile(oldSource, oldBody, { mode: 0o755 }),
        writeFile(newSource, newBody, { mode: 0o755 })
      ]);
      await symlink('bin/codex', join(oldRelease, 'codex'));
      await symlink(oldRelease, join(standalone, 'current'));
      const environment: NodeJS.ProcessEnv = {
        CODEX_HOME: codexHome,
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'runtime-update-integration',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'pending-health-check',
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      };
      let source = newSource;
      const manager = new CodexDaemonManager({
        environment,
        manager: {
          executeManagedOperation: async (_operationId, _fingerprint, action) => action()
        },
        resolveBinary: () => source,
        run: async (binary, args) => {
          const version = binary === oldSource ? '0.145.0' : '0.146.0';
          if (args[0] === '--version') {
            return { exitCode: 0, stdout: `codex-cli ${version}\n` };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              appServerVersion: version,
              backend: 'pid',
              cliVersion: version,
              managedCodexVersion: version,
              status: 'running'
            })
          };
        }
      });

      const pendingEvidence = await inspectCodexDaemonForConnectorRuntime({
        environment,
        manager
      });
      expect(pendingEvidence.state).toBe('uncertain');
      expect(await readlink(join(standalone, 'current')))
        .toBe(oldRelease);
      const selected = (await readdir(releases)).find((entry) =>
        /^0\.146\.0-project-space-[0-9a-f]{64}$/.test(entry)
      );
      expect(selected).toBeDefined();

      environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE = 'rolled-back';
      source = oldSource;
      await inspectCodexDaemonForConnectorRuntime({ environment, manager });

      expect(await readlink(join(standalone, 'current')))
        .toBe(oldRelease);
      expect(await readFile(join(standalone, 'current', 'codex'), 'utf8')).toBe(oldBody);
      expect(await readFile(join(releases, selected!, 'codex'), 'utf8')).toBe(newBody);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('finishes an accepted commit after process death before the Codex pointer switch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-codex-runtime-commit-recovery-'));
    try {
      const codexHome = join(root, 'codex-home');
      const standalone = join(codexHome, 'packages', 'standalone');
      const releases = join(standalone, 'releases');
      const oldRelease = join(releases, '0.145.0-upstream');
      const source = join(root, 'new-signed-codex');
      const outcomePath = join(root, 'maintenance', 'outcome.json');
      await mkdir(join(oldRelease, 'bin'), { mode: 0o700, recursive: true });
      await mkdir(join(root, 'maintenance'), { mode: 0o700 });
      await writeFile(
        join(oldRelease, 'bin', 'codex'),
        '#!/bin/sh\necho codex-cli 0.145.0\n',
        { mode: 0o755 }
      );
      await writeFile(source, '#!/bin/sh\necho codex-cli 0.146.0\n', { mode: 0o755 });
      await symlink('bin/codex', join(oldRelease, 'codex'));
      await symlink(oldRelease, join(standalone, 'current'));
      const environment: NodeJS.ProcessEnv = {
        CODEX_HOME: codexHome,
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'runtime-update-crash-commit',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'pending-health-check',
        PROJECT_CONNECTOR_RUNTIME_OUTCOME_FILE: outcomePath,
        PROJECT_SPACE_INSTALL_SOURCE: 'managed'
      };
      const manager = new CodexDaemonManager({
        environment,
        manager: {
          executeManagedOperation: async (_operationId, _fingerprint, action) => action()
        },
        resolveBinary: () => source,
        run: async (_binary, args) => args[0] === '--version'
          ? { exitCode: 0, stdout: 'codex-cli 0.146.0\n' }
          : {
              exitCode: 0,
              stdout: JSON.stringify({
                appServerVersion: '0.146.0', backend: 'pid', cliVersion: '0.146.0',
                managedCodexVersion: '0.146.0', status: 'running'
              })
            }
      });

      await inspectCodexDaemonForConnectorRuntime({ environment, manager });
      expect(await readlink(join(standalone, 'current'))).toBe(oldRelease);
      await writeFile(outcomePath, `${JSON.stringify({
        action: 'commit',
        operationId: 'runtime-update-crash-commit',
        schema: connectorRuntimeSupervisorOutcomeSchema
      })}\n`, { mode: 0o600 });

      await inspectCodexDaemonForConnectorRuntime({ environment, manager });
      expect(await readlink(join(standalone, 'current')))
        .toMatch(/^releases\/0\.146\.0-project-space-[0-9a-f]{64}$/);
      expect(await readFile(join(standalone, 'current', 'codex'), 'utf8'))
        .toContain('0.146.0');
      await expect(readFile(outcomePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID).toBeUndefined();
      expect(environment.PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test('never mutates the daemon outside an authenticated managed health check', async () => {
    let repairs = 0;
    const current = evidence('ready');
    const manager = {
      async execute() {
        repairs += 1;
        throw new Error('unexpected repair');
      },
      async inspect() { return current; },
      async restoreMaintenanceSelection() {
        repairs += 1;
        throw new Error('unexpected rollback');
      }
    };
    for (const environment of [
      {},
      { PROJECT_SPACE_INSTALL_SOURCE: 'managed' },
      {
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_OPERATION_ID: 'rolled-back',
        PROJECT_CONNECTOR_RUNTIME_MAINTENANCE_STATE: 'rolled-back',
        PROJECT_SPACE_INSTALL_SOURCE: 'source'
      }
    ]) {
      expect(await inspectCodexDaemonForConnectorRuntime({ environment, manager }))
        .toBe(current);
    }
    expect(repairs).toBe(0);
  });
});
