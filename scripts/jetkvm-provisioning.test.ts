import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { loadMachinePowerBindings } from '../server/machine-power/config';
import {
  desiredMqttConfig,
  planJetKvmProvisioning,
  selectJetKvmBinding,
  tailscaleInstallScript
} from './jetkvm-provisioning-lib';

test('the stored provisioning plan contains references but no secrets', async () => {
  const [binding] = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  const source = await readFile(
    resolve(process.cwd(), 'config/machine-power/os-pc.json'),
    'utf8'
  );

  assert.equal(
    binding?.provisioning.tailscale.oauthClientSecretRef,
    'env://JETKVM_PROVISIONING_TAILSCALE_CLIENT_SECRET'
  );
  assert.match(source, /"sshPrivateKeyRef": "env:\/\//);
  assert.doesNotMatch(source, /tskey-|BEGIN OPENSSH PRIVATE KEY/);
});

test('a matching second provisioning run has no changes', async () => {
  const [binding] = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  assert.ok(binding);
  const mqtt = desiredMqttConfig(
    binding,
    'jetkvm-b46e1a936ac89a4e',
    'representative-secret'
  );
  const plan = planJetKvmProvisioning(binding, {
    applicationSha256: binding.provisioning.identity.applicationSha256,
    ethernetMac: binding.provisioning.identity.ethernetMac,
    hostname: binding.provisioning.identity.deviceHostname,
    mqttConfig: mqtt,
    tailscale: {
      backendState: 'Running',
      hostname: binding.provisioning.tailscale.hostname,
      online: true,
      tags: [binding.provisioning.tailscale.tag],
      version: binding.provisioning.tailscale.version
    }
  }, mqtt);

  assert.deepEqual(plan, { changes: [], inSync: true });
});

test('provisioning rejects an ambiguous human selector', async () => {
  const [binding] = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  assert.ok(binding);
  const other = structuredClone(binding);
  other.machine.ownerUserId = 'user_other';
  other.machine.physicalMachineId = '24000000-0000-4000-8000-000000000002';

  assert.throws(
    () => selectJetKvmBinding([binding, other], 'os-pc'),
    /ambiguous/
  );
  assert.equal(
    selectJetKvmBinding(
      [binding, other],
      'os-pc',
      other.machine.physicalMachineId
    ),
    other
  );
});

test('MQTT comparison ignores key order and benign device defaults', async () => {
  const [binding] = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  assert.ok(binding);
  const mqtt = desiredMqttConfig(
    binding,
    'jetkvm-b46e1a936ac89a4e',
    'representative-secret'
  );
  const reordered = Object.fromEntries(Object.entries(mqtt).reverse());
  reordered.status_interval = 30;
  const plan = planJetKvmProvisioning(binding, observation(binding, reordered), mqtt);

  assert.deepEqual(plan, { changes: [], inSync: true });
});

test('unexpected power fields and Tailnet tags fail closed', async () => {
  const [binding] = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  assert.ok(binding);
  const mqtt = desiredMqttConfig(
    binding,
    'jetkvm-b46e1a936ac89a4e',
    'representative-secret'
  );
  const unsafe = { ...mqtt, power_action_enabled: true };
  const observed = observation(binding, unsafe);
  observed.tailscale.tags.push('tag:admin');

  assert.deepEqual(
    planJetKvmProvisioning(binding, observed, mqtt).changes,
    ['join-tailnet', 'configure-mqtt']
  );
});

test('identity mismatch fails before any change is planned', async () => {
  const [binding] = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  assert.ok(binding);
  const mqtt = desiredMqttConfig(
    binding,
    'jetkvm-b46e1a936ac89a4e',
    'representative-secret'
  );
  assert.throws(() => planJetKvmProvisioning(binding, {
    applicationSha256: binding.provisioning.identity.applicationSha256,
    ethernetMac: '00:00:00:00:00:00',
    hostname: binding.provisioning.identity.deviceHostname,
    mqttConfig: mqtt,
    tailscale: {
      backendState: null,
      hostname: null,
      online: false,
      tags: [],
      version: null
    }
  }, mqtt), /identity or pinned firmware/);
});

test('the install script accepts only a pinned semantic version', () => {
  assert.match(tailscaleInstallScript('1.98.10'), /tailscale_1\.98\.10_arm/);
  assert.throws(
    () => tailscaleInstallScript('1.98.10; reboot'),
    /Invalid pinned Tailscale version/
  );
});

function observation(
  binding: Awaited<ReturnType<typeof loadMachinePowerBindings>>[number],
  mqttConfig: Record<string, unknown>
) {
  return {
    applicationSha256: binding.provisioning.identity.applicationSha256,
    ethernetMac: binding.provisioning.identity.ethernetMac,
    hostname: binding.provisioning.identity.deviceHostname,
    mqttConfig,
    tailscale: {
      backendState: 'Running',
      hostname: binding.provisioning.tailscale.hostname,
      online: true,
      tags: [binding.provisioning.tailscale.tag],
      version: binding.provisioning.tailscale.version
    }
  };
}
