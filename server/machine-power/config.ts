import { readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export interface JetKvmProvisioning {
  bootstrapAddress: string;
  identity: {
    applicationSha256: string;
    deviceHostname: string;
    ethernetMac: string;
    sshHostKeySha256: string;
    sshPrivateKeyRef: string;
    sshPublicKeyRef: string;
  };
  schema: 'project-space.jetkvm-provisioning/v1';
  tailscale: {
    hostname: string;
    oauthClientIdRef: string;
    oauthClientSecretRef: string;
    packageBaseUrl: 'https://pkgs.tailscale.com/stable';
    tag: string;
    version: string;
  };
}

export interface JetKvmMqttBinding {
  machine: {
    ownerUserId: string;
    physicalMachineId: string;
    selector: string;
  };
  provider: {
    broker: string;
    deviceId: string;
    firmwareCompatibility: string;
    kind: 'jetkvm-mqtt';
    projectCredential: {
      credentialId: string;
      expectedUsername: string;
    };
    desiredJetKvmSettings: {
      base_topic: string;
      broker: string;
      debounce_ms: number;
      enable_actions: true;
      enable_ha_discovery: false;
      enabled: true;
      expectedUsername: string;
      passwordRef: string;
      port: number;
      tls_insecure: false;
      use_tls: true;
      usernameRef: string;
    };
    topicPrefix: string;
  };
  provisioning: JetKvmProvisioning;
  schema: 'project-space.machine-power-provider/v1';
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const topic = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const userId = /^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/;
const onePasswordReference = /^op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/;
const macAddress = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const sha256 = /^[0-9a-f]{64}$/;
const sshHostKeySha256 = /^SHA256:[A-Za-z0-9+/]{43}$/;
const tailscaleTag = /^tag:[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const tailscaleVersion = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export async function loadMachinePowerBindings(root: string) {
  const names = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
  const bindings = await Promise.all(names.map(async (name) => {
    const raw = JSON.parse(await readFile(resolve(root, name), 'utf8')) as unknown;
    return parseBinding(raw, name);
  }));
  const selectors = new Set<string>();
  const devices = new Set<string>();
  const projectCredentialIds = new Set<string>();
  const projectUsernames = new Set<string>();
  for (const binding of bindings) {
    const machineKey = `${binding.machine.ownerUserId}:${binding.machine.physicalMachineId}`;
    const projectCredential = binding.provider.projectCredential;
    if (selectors.has(machineKey) ||
        devices.has(binding.provider.deviceId) ||
        projectCredentialIds.has(projectCredential.credentialId) ||
        projectUsernames.has(projectCredential.expectedUsername)) {
      throw new Error('Machine power configuration contains a duplicate machine or device.');
    }
    selectors.add(machineKey);
    devices.add(binding.provider.deviceId);
    projectCredentialIds.add(projectCredential.credentialId);
    projectUsernames.add(projectCredential.expectedUsername);
  }
  return bindings;
}

function parseBinding(value: unknown, name: string): JetKvmMqttBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is not a machine power configuration object.`);
  }
  const binding = value as Partial<JetKvmMqttBinding>;
  const provider = binding.provider;
  if (binding.schema !== 'project-space.machine-power-provider/v1' ||
      !binding.machine || typeof binding.machine.selector !== 'string' ||
      !binding.machine.selector.trim() ||
      !uuid.test(binding.machine.physicalMachineId ?? '') ||
      !userId.test(binding.machine.ownerUserId ?? '') ||
      !provider || provider.kind !== 'jetkvm-mqtt' ||
      !identifier.test(provider.deviceId ?? '') ||
      typeof provider.broker !== 'string' ||
      !provider.broker.startsWith('mqtts://') ||
      !topic.test(provider.topicPrefix ?? '') ||
      !provider.firmwareCompatibility ||
      !provider.projectCredential ||
      !identifier.test(provider.projectCredential.credentialId ?? '') ||
      !identifier.test(provider.projectCredential.expectedUsername ?? '') ||
      !provider.desiredJetKvmSettings ||
      !binding.provisioning) {
    throw new Error(`${name} contains an invalid machine power binding.`);
  }
  const broker = new URL(provider.broker);
  if (broker.protocol !== 'mqtts:' || broker.username || broker.password ||
      (broker.pathname !== '' && broker.pathname !== '/') || broker.search || broker.hash) {
    throw new Error(`${name} must use a credential-free mqtts broker URL.`);
  }
  const desired = provider.desiredJetKvmSettings;
  if (desired.enabled !== true || desired.use_tls !== true ||
      desired.tls_insecure !== false || desired.enable_actions !== true ||
      desired.enable_ha_discovery !== false ||
      desired.broker !== broker.hostname ||
      desired.port !== Number(broker.port || '8883') ||
      desired.base_topic !== provider.topicPrefix ||
      provider.topicPrefix !==
        `project-space/jetkvm/jetkvm-${provider.deviceId}` ||
      provider.projectCredential.credentialId !==
        `jetkvm-${provider.deviceId}` ||
      provider.projectCredential.expectedUsername !==
        `project-space-jetkvm-${provider.deviceId}` ||
      desired.expectedUsername !== `jetkvm-${provider.deviceId}` ||
      desired.debounce_ms !== 500 ||
      !onePasswordReference.test(desired.usernameRef ?? '') ||
      !onePasswordReference.test(desired.passwordRef ?? '')) {
    throw new Error(`${name} contains invalid desired JetKVM settings.`);
  }
  const provisioning = binding.provisioning;
  if (provisioning.schema !== 'project-space.jetkvm-provisioning/v1' ||
      isIP(provisioning.bootstrapAddress) !== 4 ||
      provisioning.identity.deviceHostname !== `jetkvm-${provider.deviceId}` ||
      !macAddress.test(provisioning.identity.ethernetMac) ||
      !sha256.test(provisioning.identity.applicationSha256) ||
      !sshHostKeySha256.test(provisioning.identity.sshHostKeySha256) ||
      !onePasswordReference.test(provisioning.identity.sshPrivateKeyRef) ||
      !onePasswordReference.test(provisioning.identity.sshPublicKeyRef) ||
      !identifier.test(provisioning.tailscale.hostname) ||
      !tailscaleTag.test(provisioning.tailscale.tag) ||
      !tailscaleVersion.test(provisioning.tailscale.version) ||
      provisioning.tailscale.packageBaseUrl !==
        'https://pkgs.tailscale.com/stable' ||
      !onePasswordReference.test(provisioning.tailscale.oauthClientIdRef) ||
      !onePasswordReference.test(provisioning.tailscale.oauthClientSecretRef)) {
    throw new Error(`${name} contains invalid JetKVM provisioning settings.`);
  }
  return binding as JetKvmMqttBinding;
}

export function projectCredentialEnvironment(
  binding: JetKvmMqttBinding
) {
  const suffix = binding.provider.projectCredential.credentialId
    .replace(/[^A-Za-z0-9]/g, '_')
    .toUpperCase();
  return {
    password: `PROJECT_SPACE_MACHINE_POWER_MQTT_${suffix}_PASSWORD`,
    username: `PROJECT_SPACE_MACHINE_POWER_MQTT_${suffix}_USERNAME`
  };
}
