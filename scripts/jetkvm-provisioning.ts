#!/usr/bin/env bun

import { resolve } from 'node:path';

import {
  loadMachinePowerBindings,
  type JetKvmMqttBinding
} from '../server/machine-power/config';
import {
  desiredMqttConfig,
  hasExactTailscaleTag,
  isMqttConfigInSync,
  planJetKvmProvisioning,
  selectJetKvmBinding,
  sha256,
  tailscaleInstallScript,
  type JetKvmObservation
} from './jetkvm-provisioning-lib';
import {
  environmentRead,
  SecureSshSession
} from './jetkvm-provisioning-ssh';

interface Options {
  address?: string;
  apply: boolean;
  format: 'human' | 'json';
  machine: string;
  physicalMachineId?: string;
}

interface OneUseAuthKey {
  accessToken: string;
  id: string;
  key: string;
}

const options = parseOptions(process.argv.slice(2));
const bindings = await loadMachinePowerBindings(
  resolve(process.cwd(), 'config/machine-power')
);
const binding = selectJetKvmBinding(
  bindings,
  options.machine,
  options.physicalMachineId
);

const address = options.address ?? binding.provisioning.bootstrapAddress;
const session = await SecureSshSession.open(address, binding);
try {
  const mqttUsername = environmentRead(
    binding.provider.desiredJetKvmSettings.usernameRef
  );
  const mqttPassword = environmentRead(
    binding.provider.desiredJetKvmSettings.passwordRef
  );
  const desiredMqtt = desiredMqttConfig(
    binding,
    mqttUsername.trim(),
    mqttPassword.trim()
  );
  let observation = await observe(session);
  const initialPlan = planJetKvmProvisioning(
    binding,
    observation,
    desiredMqtt
  );

  if (!options.apply || initialPlan.inSync) {
    printResult(options, {
      address,
      applied: false,
      changes: initialPlan.changes,
      inSync: initialPlan.inSync,
      machine: binding.machine.selector
    });
    process.exitCode = initialPlan.inSync ? 0 : 2;
  } else {
    if (initialPlan.changes.includes('install-tailscale')) {
      await installTailscale(session, binding);
    }
    observation = await observe(session);
    if (initialPlan.changes.includes('join-tailnet') ||
        observation.tailscale.backendState !== 'Running' ||
        !observation.tailscale.online) {
      await joinTailnet(session, binding);
    }
    observation = await observe(session);
    if (observation.tailscale.backendState !== 'Running' ||
        !observation.tailscale.online ||
        observation.tailscale.hostname !==
          binding.provisioning.tailscale.hostname ||
        !hasExactTailscaleTag(
          observation.tailscale.tags,
          binding.provisioning.tailscale.tag
        )) {
      throw new Error('Tailscale did not reach the expected running state.');
    }
    if (initialPlan.changes.includes('configure-mqtt')) {
      await applyMqttConfig(session, desiredMqtt);
    }

    const finalObservation = await observe(session);
    const finalPlan = planJetKvmProvisioning(
      binding,
      finalObservation,
      desiredMqtt
    );
    if (!finalPlan.inSync) {
      throw new Error(
        `JetKVM provisioning still has drift: ${finalPlan.changes.join(', ')}.`
      );
    }
    printResult(options, {
      address,
      applied: true,
      changes: initialPlan.changes,
      inSync: true,
      machine: binding.machine.selector
    });
  }
} finally {
  await session.close();
}

async function observe(session: SecureSshSession): Promise<JetKvmObservation> {
  const identity = (await session.ssh(
    'hostname; cat /sys/class/net/eth0/address; ' +
    'sha256sum /userdata/jetkvm/bin/jetkvm_app | cut -d " " -f 1'
  )).trim().split('\n');
  if (identity.length !== 3) {
    throw new Error('Could not read the JetKVM identity.');
  }
  const config = JSON.parse(await session.ssh(
    'cat /userdata/kvm_config.json'
  )) as { mqtt_config?: Record<string, unknown> };
  if (!config.mqtt_config) {
    throw new Error('JetKVM does not expose an MQTT configuration.');
  }
  const tailscaleRaw = await session.ssh(
    'if command -v tailscale >/dev/null 2>&1; then ' +
    'tailscale version | sed -n "1p"; ' +
    'tailscale status --json 2>/dev/null || true; ' +
    'else echo "__NOT_INSTALLED__"; fi'
  );
  if (tailscaleRaw.trim() === '__NOT_INSTALLED__') {
    return {
      applicationSha256: identity[2]!,
      ethernetMac: identity[1]!,
      hostname: identity[0]!,
      mqttConfig: config.mqtt_config,
      tailscale: {
        backendState: null,
        hostname: null,
        online: false,
        tags: [],
        version: null
      }
    };
  }
  const newline = tailscaleRaw.indexOf('\n');
  const statusText = newline >= 0 ? tailscaleRaw.slice(newline + 1).trim() : '';
  const status = statusText ? JSON.parse(statusText) as {
    BackendState?: string;
    Self?: { HostName?: string; Online?: boolean; Tags?: string[] };
  } : {};
  return {
    applicationSha256: identity[2]!,
    ethernetMac: identity[1]!,
    hostname: identity[0]!,
    mqttConfig: config.mqtt_config,
    tailscale: {
      backendState: status.BackendState ?? null,
      hostname: status.Self?.HostName ?? null,
      online: status.Self?.Online === true,
      tags: status.Self?.Tags ?? [],
      version: tailscaleRaw.slice(0, newline).trim()
    }
  };
}

async function installTailscale(
  session: SecureSshSession,
  binding: JetKvmMqttBinding
) {
  const desired = binding.provisioning.tailscale;
  const packageUrl =
    `${desired.packageBaseUrl}/tailscale_${desired.version}_arm.tgz`;
  const checksumResponse = await fetch(`${packageUrl}.sha256`, {
    signal: AbortSignal.timeout(30_000)
  });
  const packageResponse = await fetch(packageUrl, {
    signal: AbortSignal.timeout(30_000)
  });
  if (!checksumResponse.ok || !packageResponse.ok) {
    throw new Error('Could not download the pinned Tailscale package.');
  }
  const expected = (await checksumResponse.text()).trim().split(/\s+/)[0];
  const archive = new Uint8Array(await packageResponse.arrayBuffer());
  if (!expected || sha256(archive) !== expected) {
    throw new Error('The pinned Tailscale package checksum does not match.');
  }
  await session.ssh('cat > /userdata/tailscale.tgz', archive);
  await session.ssh(
    'ash -s',
    tailscaleInstallScript(desired.version),
    false
  );
  await rebootAndWait(session);
}

async function joinTailnet(
  session: SecureSshSession,
  binding: JetKvmMqttBinding
) {
  const tailscale = binding.provisioning.tailscale;
  const authKey = await createOneUseAuthKey(tailscale);
  try {
    await session.ssh(
      `IFS= read -r TS_AUTH_KEY
export TS_AUTH_KEY
tailscale up --auth-key="$TS_AUTH_KEY" ` +
      `--hostname='${tailscale.hostname}' ` +
      `--advertise-tags='${tailscale.tag}' >/dev/null
unset TS_AUTH_KEY`,
      `${authKey.key}\n`
    );
  } catch (error) {
    const revoked = await revokeOneUseAuthKey(authKey);
    if (!revoked) {
      throw new Error(
        'Tailnet join failed and its one-use auth key could not be revoked.',
        { cause: error }
      );
    }
    throw error;
  } finally {
    authKey.accessToken = '';
    authKey.key = '';
  }
}

async function createOneUseAuthKey(
  tailscale: JetKvmMqttBinding['provisioning']['tailscale']
) {
  let clientId = environmentRead(tailscale.oauthClientIdRef).trim();
  let clientSecret = environmentRead(tailscale.oauthClientSecretRef).trim();
  const tokenResponse = await fetch(
    'https://api.tailscale.com/api/v2/oauth/token',
    {
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'auth_keys',
        tags: tailscale.tag
      }),
      headers: {
        Authorization:
          `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      method: 'POST',
      signal: AbortSignal.timeout(30_000)
    }
  );
  clientId = '';
  clientSecret = '';
  if (!tokenResponse.ok) {
    throw new Error('The Tailscale provisioning credential was rejected.');
  }
  const token = await tokenResponse.json() as { access_token?: string };
  if (!token.access_token) {
    throw new Error('Tailscale did not return an access token.');
  }
  const accessToken = token.access_token;
  const keyResponse = await fetch(
    'https://api.tailscale.com/api/v2/tailnet/-/keys',
    {
      body: JSON.stringify({
        capabilities: {
          devices: {
            create: {
              ephemeral: false,
              preauthorized: true,
              reusable: false,
              tags: [tailscale.tag]
            }
          }
        },
        expirySeconds: 600
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      method: 'POST',
      signal: AbortSignal.timeout(30_000)
    }
  );
  if (!keyResponse.ok) {
    token.access_token = '';
    throw new Error('Tailscale did not create a one-use auth key.');
  }
  const key = await keyResponse.json() as { id?: string; key?: string };
  if (!key.id || !key.key) {
    token.access_token = '';
    throw new Error('Tailscale returned no one-use auth key.');
  }
  token.access_token = '';
  return {
    accessToken,
    id: key.id,
    key: key.key
  };
}

async function revokeOneUseAuthKey(key: OneUseAuthKey) {
  try {
    const response = await fetch(
      `https://api.tailscale.com/api/v2/tailnet/-/keys/${key.id}`,
      {
        headers: { Authorization: `Bearer ${key.accessToken}` },
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000)
      }
    );
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function applyMqttConfig(
  session: SecureSshSession,
  mqttConfig: Record<string, unknown>
) {
  const original = await session.ssh('cat /userdata/kvm_config.json');
  const config = JSON.parse(original) as Record<string, unknown>;
  config.mqtt_config = mqttConfig;
  const updated = `${JSON.stringify(config, null, 2)}\n`;
  JSON.parse(updated);
  const originalDigest = sha256(new TextEncoder().encode(original));
  const updatedDigest = sha256(new TextEncoder().encode(updated));
  const backup =
    `/userdata/kvm_config.json.project-space.backup.${originalDigest}`;
  await session.ssh(
    `set -eu
umask 077
current="$(sha256sum /userdata/kvm_config.json | cut -d " " -f 1)"
test "$current" = '${originalDigest}'
if [ ! -f '${backup}' ]; then
  cp -p /userdata/kvm_config.json '${backup}'
fi
cat > /userdata/kvm_config.json.project-space.new
staged="$(sha256sum /userdata/kvm_config.json.project-space.new | cut -d " " -f 1)"
test "$staged" = '${updatedDigest}'
mv /userdata/kvm_config.json.project-space.new /userdata/kvm_config.json
sync`,
    updated
  );
  try {
    await rebootAndWait(session);
    const verified = JSON.parse(await session.ssh(
      'cat /userdata/kvm_config.json'
    )) as { mqtt_config?: Record<string, unknown> };
    if (!verified.mqtt_config ||
        !isMqttConfigInSync(verified.mqtt_config, mqttConfig)) {
      throw new Error('JetKVM did not retain the expected MQTT configuration.');
    }
  } catch (error) {
    if (await restoreMqttConfig(session, backup, originalDigest)) {
      throw new Error(
        'JetKVM did not recover with the new MQTT configuration; ' +
        'the previous configuration was restored.',
        { cause: error }
      );
    }
    throw error;
  }
}

async function restoreMqttConfig(
  session: SecureSshSession,
  backup: string,
  expectedDigest: string
) {
  const available = await session.ssh(
    `[ -f '${backup}' ]`,
    undefined,
    true
  );
  if (available === '__COMMAND_FAILED__') {
    return false;
  }
  await session.ssh(
    `set -eu
umask 077
cp -p '${backup}' /userdata/kvm_config.json.project-space.restore
restored="$(sha256sum /userdata/kvm_config.json.project-space.restore | cut -d " " -f 1)"
test "$restored" = '${expectedDigest}'
mv /userdata/kvm_config.json.project-space.restore /userdata/kvm_config.json
sync`
  );
  await rebootAndWait(session);
  return true;
}

async function rebootAndWait(session: SecureSshSession) {
  await session.ssh(
    "nohup sh -c 'sleep 1; reboot' >/dev/null 2>&1 &"
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Bun.sleep(1_000);
    const result = await session.ssh('true', undefined, true);
    if (result === '__COMMAND_FAILED__') {
      await waitForSsh(session);
      return;
    }
  }
  throw new Error('JetKVM did not disconnect for its configuration reboot.');
}

async function waitForSsh(session: SecureSshSession) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await Bun.sleep(1_000);
    const result = await session.ssh('true', undefined, true);
    if (result !== '__COMMAND_FAILED__') {
      return;
    }
  }
  throw new Error('JetKVM did not return after its configuration reboot.');
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    apply: false,
    format: 'human',
    machine: ''
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--machine') {
      options.machine = args[++index] ?? '';
    } else if (arg === '--address') {
      options.address = args[++index];
    } else if (arg === '--physical-machine-id') {
      options.physicalMachineId = args[++index];
    } else if (arg === '--format') {
      const format = args[++index];
      if (format !== 'human' && format !== 'json') {
        throw new Error('--format must be human or json.');
      }
      options.format = format;
    } else {
      throw new Error(
        'Usage: bun run jetkvm:provision --machine <selector> ' +
        '[--physical-machine-id <uuid>] [--address <IPv4>] ' +
        '[--apply] [--format human|json]'
      );
    }
  }
  if (!options.machine) {
    throw new Error('--machine is required.');
  }
  return options;
}

function printResult(
  options: Options,
  result: {
    address: string;
    applied: boolean;
    changes: string[];
    inSync: boolean;
    machine: string;
  }
) {
  if (options.format === 'json') {
    console.log(JSON.stringify(result));
    return;
  }
  if (result.inSync && !result.applied) {
    console.log(`${result.machine}: JetKVM configuration is already in sync.`);
    return;
  }
  const action = result.applied ? 'Applied' : 'Would apply';
  console.log(`${action} for ${result.machine}: ${result.changes.join(', ')}.`);
}
