import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { connectAsync, type MqttClient } from 'mqtt';

import { renderMachinePowerBrokerAcl } from '../server/machine-power/broker-acl';
import type { JetKvmMqttBinding } from '../server/machine-power/config';

const image = 'eclipse-mosquitto:2.1.2-alpine';
const root = await mkdtemp(resolve(tmpdir(), 'project-space-mqtt-isolation-'));
const container = `project-space-mqtt-isolation-${randomUUID()}`;
const passwords = new Map([
  ['project-space-jetkvm-device-a', randomBytes(24).toString('base64url')],
  ['project-space-jetkvm-device-b', randomBytes(24).toString('base64url')],
  ['jetkvm-device-a', randomBytes(24).toString('base64url')],
  ['jetkvm-device-b', randomBytes(24).toString('base64url')]
]);
const clients: MqttClient[] = [];

try {
  const bindings = [
    binding('a', '11111111-1111-4111-8111-111111111111', 'owner-a'),
    binding('b', '22222222-2222-4222-8222-222222222222', 'owner-b')
  ];
  await writeFile(resolve(root, 'acl'), renderMachinePowerBrokerAcl(bindings));
  await writeFile(resolve(root, 'mosquitto.conf'), [
    'listener 1883',
    'allow_anonymous false',
    'password_file /mosquitto/config/password_file',
    'acl_file /mosquitto/config/acl',
    'log_dest stdout'
  ].join('\n'));
  for (const [index, [username, password]] of [...passwords].entries()) {
    docker([
      'run', '--rm', '-v', `${root}:/mosquitto/config`, image,
      'mosquitto_passwd', '-b', ...(index === 0 ? ['-c'] : []),
      '/mosquitto/config/password_file', username, password
    ]);
  }
  docker([
    'run', '--rm', '-d', '--name', container,
    '-p', '127.0.0.1::1883',
    '-v', `${root}:/mosquitto/config:ro`,
    image
  ]);
  const port = docker(['port', container, '1883/tcp']).trim().split(':').at(-1);
  assert.match(port ?? '', /^\d+$/);
  const broker = `mqtt://127.0.0.1:${port}`;

  const appA = await client(broker, 'project-space-jetkvm-device-a');
  const appB = await client(broker, 'project-space-jetkvm-device-b');
  const deviceA = await client(broker, 'jetkvm-device-a');
  const deviceB = await client(broker, 'jetkvm-device-b');
  clients.push(appA, appB, deviceA, deviceB);

  const appAMessages = messages(appA);
  const appBMessages = messages(appB);
  await appA.subscribeAsync('project-space/jetkvm/+/status');
  await appB.subscribeAsync('project-space/jetkvm/+/status');
  await deviceA.publishAsync(
    'project-space/jetkvm/jetkvm-device-a/status', '{"online":true}'
  );
  await deviceB.publishAsync(
    'project-space/jetkvm/jetkvm-device-b/status', '{"online":true}'
  );
  await settle();
  assert.deepEqual(appAMessages.map(({ topic }) => topic), [
    'project-space/jetkvm/jetkvm-device-a/status'
  ]);
  assert.deepEqual(appBMessages.map(({ topic }) => topic), [
    'project-space/jetkvm/jetkvm-device-b/status'
  ]);

  const commandsA = messages(deviceA);
  const commandsB = messages(deviceB);
  await deviceA.subscribeAsync(
    'project-space/jetkvm/jetkvm-device-a/atx_power_short/set'
  );
  await deviceB.subscribeAsync(
    'project-space/jetkvm/jetkvm-device-b/atx_power_short/set'
  );
  await appA.publishAsync(
    'project-space/jetkvm/jetkvm-device-a/atx_power_short/set', 'PRESS'
  );
  await appB.publishAsync(
    'project-space/jetkvm/jetkvm-device-b/atx_power_short/set', 'PRESS'
  );
  await settle();
  assert.equal(commandsA.length, 1);
  assert.equal(commandsB.length, 1);

  await publishDenied(
    appA,
    'project-space/jetkvm/jetkvm-device-b/atx_power_short/set'
  );
  await publishDenied(
    deviceA,
    'project-space/jetkvm/jetkvm-device-b/status'
  );
  await settle();
  assert.equal(commandsB.length, 1);
  assert.equal(appBMessages.length, 1);

  console.log(
    'mqttIsolation=true appAToB=false appBToA=false deviceAToB=false ' +
      'exactCommands=true'
  );
} finally {
  await Promise.all(clients.map((connected) =>
    connected.endAsync().catch(() => undefined)
  ));
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  await rm(root, { force: true, recursive: true });
}

function binding(
  suffix: string,
  physicalMachineId: string,
  ownerUserId: string
): JetKvmMqttBinding {
  const deviceId = `device-${suffix}`;
  const prefix = `project-space/jetkvm/jetkvm-${deviceId}`;
  return {
    machine: {
      ownerUserId,
      physicalMachineId,
      selector: `machine-${suffix}`
    },
    provider: {
      broker: 'mqtts://mqtt.example.test:8883',
      deviceId,
      firmwareCompatibility: 'release/test',
      kind: 'jetkvm-mqtt',
      projectCredential: {
        credentialId: `jetkvm-${deviceId}`,
        expectedUsername: `project-space-jetkvm-${deviceId}`
      },
      desiredJetKvmSettings: {
        base_topic: prefix,
        broker: 'mqtt.example.test',
        debounce_ms: 500,
        enable_actions: true,
        enable_ha_discovery: false,
        enabled: true,
        expectedUsername: `jetkvm-${deviceId}`,
        passwordRef: `op://test/device-${suffix}/password`,
        port: 8883,
        tls_insecure: false,
        use_tls: true,
        usernameRef: `op://test/device-${suffix}/username`
      },
      topicPrefix: prefix
    },
    provisioning: {
      bootstrapAddress: '192.0.2.1',
      identity: {
        applicationSha256:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        deviceHostname: `jetkvm-${deviceId}`,
        ethernetMac: '00:11:22:33:44:55',
        sshHostKeySha256:
          'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        sshPrivateKeyRef: `op://test/device-${suffix}/private_key`,
        sshPublicKeyRef: `op://test/device-${suffix}/public_key`
      },
      schema: 'project-space.jetkvm-provisioning/v1',
      tailscale: {
        hostname: `jetkvm-${suffix}`,
        oauthClientIdRef: 'op://test/tailscale/username',
        oauthClientSecretRef: 'op://test/tailscale/password',
        packageBaseUrl: 'https://pkgs.tailscale.com/stable',
        tag: 'tag:jetkvm',
        version: '1.98.10'
      }
    },
    schema: 'project-space.machine-power-provider/v1'
  };
}

function docker(arguments_: string[]) {
  const result = spawnSync('docker', arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `docker ${arguments_[0]} failed`);
  }
  return result.stdout;
}

async function client(broker: string, username: string) {
  return connectAsync(broker, {
    clean: true,
    connectTimeout: 5_000,
    password: passwords.get(username),
    reconnectPeriod: 0,
    username
  });
}

function messages(client_: MqttClient) {
  const received: Array<{ payload: string; topic: string }> = [];
  client_.on('message', (topic, payload) => {
    received.push({ payload: payload.toString('utf8'), topic });
  });
  return received;
}

async function publishDenied(client_: MqttClient, topic: string) {
  try {
    await client_.publishAsync(topic, 'DENIED', { qos: 1 });
  } catch {
    // Mosquitto may disconnect a client that attempts a denied write.
  }
}

async function settle() {
  await new Promise((resolveSettle) => setTimeout(resolveSettle, 250));
}
