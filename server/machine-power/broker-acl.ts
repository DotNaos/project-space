import type { JetKvmMqttBinding } from './config';

export function renderMachinePowerBrokerAcl(
  bindings: readonly JetKvmMqttBinding[]
) {
  const lines = [
    '# Generated from config/machine-power/*.json.',
    '# Run: bun run machine-power:mqtt-acl:generate',
    '# Every application and device credential is restricted to one exact JetKVM.',
    ''
  ];
  for (const binding of [...bindings].sort(
    (left, right) => left.provider.deviceId.localeCompare(right.provider.deviceId)
  )) {
    const prefix = binding.provider.topicPrefix;
    lines.push(
      `# Project Space provider for ${binding.machine.selector}.`,
      `user ${binding.provider.projectCredential.expectedUsername}`,
      `topic read ${prefix}/status`,
      `topic read ${prefix}/atx/state`,
      `topic read ${prefix}/update/state`,
      `topic write ${prefix}/atx_power_short/set`,
      '',
      `# JetKVM device for ${binding.machine.selector}.`,
      `user ${binding.provider.desiredJetKvmSettings.expectedUsername}`,
      `topic write ${prefix}/status`,
      `topic write ${prefix}/atx/state`,
      `topic write ${prefix}/update/state`,
      `topic read ${prefix}/atx_power_short/set`,
      ''
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
