import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = resolve(process.cwd(), 'deploy/mqtt');
const updateScript = resolve(root, 'update-password-client.sh');
const removeScript = resolve(root, 'remove-password-client.sh');
const expectScript = resolve(root, 'update-password-client.expect');
const maliciousUsernames = [
  'project-space-jetkvm-a;touch-pwned',
  'jetkvm-a$(id)',
  'jetkvm-a with-space',
  'jetkvm-a\nsecond-command',
  `jetkvm-${'a'.repeat(129)}`
];

test('MQTT credential scripts reject shell syntax before any privileged work', () => {
  for (const username of maliciousUsernames) {
    for (const script of [updateScript, removeScript]) {
      const result = spawnSync('sh', [script, username], { encoding: 'utf8' });
      assert.equal(result.status, 64, `${script} accepted ${JSON.stringify(username)}`);
      assert.match(result.stderr, /usage:/);
    }
    const wrapper = spawnSync('expect', [expectScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MQTT_CLIENT_PASSWORD: 'test-only-not-a-secret',
        MQTT_CLIENT_USERNAME: username,
        REMOTE_SCRIPT_PATH: '/tmp/does-not-exist'
      }
    });
    assert.equal(wrapper.status, 64, `Expect accepted ${JSON.stringify(username)}`);
    assert.match(wrapper.stderr, /invalid MQTT client username/);
  }
});

test('MQTT password mutations are serialized and atomically replace one unique file', async () => {
  for (const script of [updateScript, removeScript]) {
    const source = await readFile(script, 'utf8');
    const lock = source.indexOf('flock -x 9');
    const snapshot = source.indexOf('install -m 0600 "$password_file"');
    assert(lock >= 0 && snapshot > lock, `${script} snapshots before acquiring its lock`);
    assert.match(source, /password_file\.new\.\$\$/);
    assert.match(source, /mv "\$new_password_file" "\$password_file"/);
    assert.doesNotMatch(source, /password_file\.new"/);
  }
});
