import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type {
  JetKvmMqttBinding,
  JetKvmProvisioning
} from '../server/machine-power/config';

export interface JetKvmObservation {
  applicationSha256: string;
  ethernetMac: string;
  hostname: string;
  mqttConfig: Record<string, unknown>;
  tailscale: {
    backendState: string | null;
    hostname: string | null;
    online: boolean;
    tags: string[];
    version: string | null;
  };
}

export interface JetKvmProvisioningPlan {
  changes: Array<'install-tailscale' | 'join-tailnet' | 'configure-mqtt'>;
  inSync: boolean;
}

export function selectJetKvmBinding(
  bindings: JetKvmMqttBinding[],
  selector: string,
  physicalMachineId?: string
) {
  const matches = bindings.filter((binding) =>
    binding.machine.selector === selector &&
    (!physicalMachineId ||
      binding.machine.physicalMachineId === physicalMachineId)
  );
  if (matches.length === 0) {
    throw new Error(`No JetKVM binding exists for ${selector}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${selector} is ambiguous; provide --physical-machine-id.`
    );
  }
  return matches[0]!;
}

export function desiredMqttConfig(
  binding: JetKvmMqttBinding,
  username: string,
  password: string
) {
  const desired = binding.provider.desiredJetKvmSettings;
  if (username !== desired.expectedUsername) {
    throw new Error('The JetKVM MQTT username does not match the binding.');
  }
  return {
    enabled: desired.enabled,
    broker: desired.broker,
    port: desired.port,
    username,
    password,
    base_topic: desired.base_topic,
    use_tls: desired.use_tls,
    tls_insecure: desired.tls_insecure,
    enable_ha_discovery: desired.enable_ha_discovery,
    enable_actions: desired.enable_actions,
    debounce_ms: desired.debounce_ms
  };
}

export function planJetKvmProvisioning(
  binding: JetKvmMqttBinding,
  observation: JetKvmObservation,
  mqttConfig: Record<string, unknown>
): JetKvmProvisioningPlan {
  assertJetKvmIdentity(binding.provisioning, observation);
  const changes: JetKvmProvisioningPlan['changes'] = [];
  if (observation.tailscale.version !== binding.provisioning.tailscale.version) {
    changes.push('install-tailscale');
  }
  if (observation.tailscale.backendState !== 'Running' ||
      !observation.tailscale.online ||
      observation.tailscale.hostname !== binding.provisioning.tailscale.hostname ||
      !hasExactTailscaleTag(
        observation.tailscale.tags,
        binding.provisioning.tailscale.tag
      )) {
    changes.push('join-tailnet');
  }
  if (!isMqttConfigInSync(observation.mqttConfig, mqttConfig)) {
    changes.push('configure-mqtt');
  }
  return { changes, inSync: changes.length === 0 };
}

export function hasExactTailscaleTag(tags: string[], expected: string) {
  return tags.length === 1 && tags[0] === expected;
}

export function assertJetKvmIdentity(
  provisioning: JetKvmProvisioning,
  observation: Pick<
    JetKvmObservation,
    'applicationSha256' | 'ethernetMac' | 'hostname'
  >
) {
  const expected = provisioning.identity;
  if (observation.hostname !== expected.deviceHostname ||
      observation.ethernetMac.toLowerCase() !== expected.ethernetMac ||
      observation.applicationSha256 !== expected.applicationSha256) {
    throw new Error('JetKVM identity or pinned firmware does not match.');
  }
}

export function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function tailscaleInstallScript(version: string) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error('Invalid pinned Tailscale version.');
  }
  return `set -eu
cd /userdata
mkdir -p tailscale
tar xf tailscale.tgz
cp -r tailscale_${version}_arm/* tailscale/
rm -r tailscale_${version}_arm tailscale.tgz
cd tailscale
./tailscale configure jetkvm >/dev/null 2>&1
sync
`;
}

export function isMqttConfigInSync(
  observed: Record<string, unknown>,
  desired: Record<string, unknown>
) {
  for (const [key, value] of Object.entries(desired)) {
    if (!isDeepStrictEqual(observed[key], value)) {
      return false;
    }
  }
  return !Object.keys(observed).some((key) =>
    !(key in desired) &&
    /action|atx|power|reset|reboot|shutdown/i.test(key)
  );
}
