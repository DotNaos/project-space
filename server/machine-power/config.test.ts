import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { renderMachinePowerBrokerAcl } from './broker-acl';
import {
  loadMachinePowerBindings,
  projectCredentialEnvironment
} from './config';
import { resolveProjectMqttCredential } from './provider';

test('the checked-in JetKVM binding is exact and contains no password', async () => {
  const root = resolve(process.cwd(), 'config/machine-power');
  const bindings = await loadMachinePowerBindings(root);

  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]?.machine.selector, 'os-pc');
  assert.equal(bindings[0]?.machine.ownerUserId, 'user_3FttZKw76HQHfv7mRADNRyAwaEh');
  assert.equal(
    bindings[0]?.machine.physicalMachineId,
    '24000000-0000-4000-8000-000000000001'
  );
  assert.equal(bindings[0]?.provider.deviceId, 'b46e1a936ac89a4e');
  const source = await readFile(resolve(root, 'os-pc.json'), 'utf8');
  assert.doesNotMatch(source, /"password"\s*:/);
  assert.doesNotMatch(source, /usernameEnv|passwordEnv/);
  assert.deepEqual(projectCredentialEnvironment(bindings[0]!), {
    password:
      'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_PASSWORD',
    username:
      'PROJECT_SPACE_MACHINE_POWER_MQTT_JETKVM_B46E1A936AC89A4E_USERNAME'
  });
});

test('the generated broker ACL grants one exact application and device boundary', async () => {
  const bindings = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  const acl = await readFile(resolve(process.cwd(), 'deploy/mqtt/config/acl'), 'utf8');
  assert.equal(acl, renderMachinePowerBrokerAcl(bindings));
  const projectRules = acl
    .split('\n')
    .slice(
      acl.split('\n').indexOf(
        'user project-space-jetkvm-b46e1a936ac89a4e'
      ) + 1
    )
    .filter((line) => line.startsWith('topic '))
    .slice(0, 4);

  assert.deepEqual(projectRules, [
    'topic read project-space/jetkvm/jetkvm-b46e1a936ac89a4e/status',
    'topic read project-space/jetkvm/jetkvm-b46e1a936ac89a4e/atx/state',
    'topic read project-space/jetkvm/jetkvm-b46e1a936ac89a4e/update/state',
    'topic write project-space/jetkvm/jetkvm-b46e1a936ac89a4e/atx_power_short/set'
  ]);
  assert.doesNotMatch(
    acl.split('\n').filter((line) => line.startsWith('topic ')).join('\n'),
    /[+#]/
  );
  assert.doesNotMatch(projectRules.join('\n'), /long|reset|reboot|dc_power/);
  assert.doesNotMatch(projectRules.join('\n'), /write .*update/);
});

test('a provider can resolve only its derived credential and exact username', async () => {
  const [binding] = await loadMachinePowerBindings(
    resolve(process.cwd(), 'config/machine-power')
  );
  const names = projectCredentialEnvironment(binding!);
  assert.throws(
    () => resolveProjectMqttCredential(binding!, {}),
    /not configured/
  );
  assert.throws(
    () => resolveProjectMqttCredential(binding!, {
      [names.password]: 'not-a-real-secret',
      [names.username]: 'project-space-another-device'
    }),
    /identity does not match/
  );
  assert.deepEqual(resolveProjectMqttCredential(binding!, {
    [names.password]: 'not-a-real-secret',
    [names.username]: binding!.provider.projectCredential.expectedUsername
  }), {
    password: 'not-a-real-secret',
    username: 'project-space-jetkvm-b46e1a936ac89a4e'
  });
});

test('the binding cannot report one JetKVM while controlling another namespace', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'machine-power-config-'));
  try {
    const binding = JSON.parse(await readFile(
      resolve(process.cwd(), 'config/machine-power/os-pc.json'),
      'utf8'
    )) as { provider: { deviceId: string } };
    binding.provider.deviceId = 'another-device';
    await writeFile(resolve(root, 'mismatch.json'), JSON.stringify(binding));

    await assert.rejects(
      loadMachinePowerBindings(root),
      /invalid desired JetKVM settings/
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
