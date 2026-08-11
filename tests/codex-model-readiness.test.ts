import { describe, expect, test } from 'bun:test';

import {
  codexModelReadinessPresentation,
  codexModelSettingsAvailable
} from '../src/features/codex-sessions/codex-model-readiness';

describe('Codex model readiness presentation', () => {
  test('turns a deferred connector update into a concrete reason and recovery path', () => {
    expect(codexModelReadinessPresentation({
      machineId: 'linux-stable',
      supportsModelSettings: true,
      runtime: {
        capabilities: [],
        machineId: 'linux-stable',
        online: true,
        update: {
          lastFailure: {
            at: '2026-08-10T12:00:00.000Z',
            code: 'codex-waiting-approval',
            message: 'Update deferred until the pending approval is resolved.',
            rollbackAvailable: false
          },
          state: 'update-pending'
        }
      }
    })).toEqual({
      modelSettingsRecoveryCommand: 'project doctor --machine-id linux-stable',
      modelSettingsRecoveryHref: '/settings',
      modelSettingsUnavailableReason: 'Update deferred until the pending approval is resolved.'
    });
    expect(codexModelSettingsAvailable({
      machineId: 'linux-stable',
      supportsModelSettings: true,
      runtime: {
        capabilities: [],
        machineId: 'linux-stable',
        online: true,
        update: { state: 'update-pending' }
      }
    })).toBe(false);
  });

  test('describes the exact available connector version', () => {
    const input = {
      machineId: 'linux-stable',
      supportsModelSettings: true,
      runtime: {
        capabilities: ['codex.sessions.model-settings.v1', 'runtime.restart'],
        machineId: 'linux-stable',
        online: true,
        runtime: {
          architecture: 'x64',
          buildId: 'a'.repeat(40),
          bundleVersions: { connector: '1.0.0', machineTools: '1.0.0', projectCli: '1.0.0' },
          channel: 'stable',
          instanceId: 'instance-one',
          lastCheckedAt: '2026-08-10T12:00:00.000Z',
          platform: 'linux',
          protocolVersion: '2',
          releaseId: 'v1.0.0',
          source: 'managed',
          version: '1.0.0'
        },
        update: { availableVersion: '1.2.0', state: 'update-required' }
      }
    } as const;
    expect(codexModelReadinessPresentation(input).modelSettingsUnavailableReason).toBe(
      'Model settings require the approved connector update from v1.0.0 to v1.2.0.'
    );
    expect(codexModelSettingsAvailable(input)).toBe(false);
  });

  test('stays empty when compatible model settings are available', () => {
    expect(codexModelReadinessPresentation({
      machineId: 'linux-stable',
      supportsModelSettings: true
    })).toEqual({});
  });
});
