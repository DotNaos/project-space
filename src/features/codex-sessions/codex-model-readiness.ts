import type { MachineRuntimeStatusResult } from '@/shared/project-space-api';

export interface CodexModelReadinessPresentation {
  modelSettingsRecoveryCommand?: string;
  modelSettingsRecoveryHref?: string;
  modelSettingsUnavailableReason?: string;
}

type CodexModelReadinessInput = {
  machineId: string;
  runtime?: MachineRuntimeStatusResult;
  statusDetail?: string;
  supportsModelSettings?: boolean;
};

function version(value: string | undefined) {
  return value ? `v${value}` : 'an unknown version';
}

function runtimeBlocksModelSettings(runtime: MachineRuntimeStatusResult | undefined) {
  const state = runtime?.update.state;
  return state !== undefined && state !== 'up-to-date' && state !== 'unsupported';
}

export function codexModelSettingsAvailable(input: CodexModelReadinessInput) {
  return input.supportsModelSettings === true && !runtimeBlocksModelSettings(input.runtime);
}

export function codexModelReadinessPresentation(
  input: CodexModelReadinessInput
): CodexModelReadinessPresentation {
  if (codexModelSettingsAvailable(input)) return {};
  const update = input.runtime?.update;
  const failure = update?.lastFailure?.message ?? update?.operation?.lastFailure?.message;
  let reason = failure;
  if (!reason && update?.state === 'update-pending') {
    reason = 'Model settings are paused until the approved connector update can start.';
  } else if (!reason && (update?.state === 'updating' || update?.state === 'restarting')) {
    reason = 'Model settings are paused while the connector and Codex runtime update.';
  } else if (!reason && update?.state === 'rollback') {
    reason = 'Model settings are paused because the connector update is being recovered.';
  } else if (!reason && update?.state === 'failed') {
    reason = 'Model settings are paused because connector runtime recovery is required.';
  } else if (!reason && (update?.state === 'update-required' || update?.state === 'update-available')) {
    reason = `Model settings require the approved connector update from ${version(
      input.runtime?.runtime?.version
    )} to ${version(update.availableVersion)}.`;
  } else if (!reason && update?.state === 'offline') {
    reason = 'Model settings are unavailable while this machine connector is offline.';
  } else if (!reason && update?.state === 'unknown') {
    reason = 'Model settings are unavailable because the approved connector release is unknown.';
  } else if (!reason && update?.state === 'restart-required') {
    reason = 'Model settings are paused until the managed connector restart finishes.';
  } else if (!reason && update?.state === 'checking') {
    reason = 'Model settings are paused while the approved connector release is checked.';
  }
  reason ??= input.statusDetail ||
    'Model settings are unavailable because this connector has not proved compatible Codex readiness.';
  return {
    modelSettingsRecoveryCommand: `project doctor --machine-id ${input.machineId}`,
    modelSettingsRecoveryHref: '/settings',
    modelSettingsUnavailableReason: reason
  };
}
