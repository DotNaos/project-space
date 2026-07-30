import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { renderMachinePowerBrokerAcl } from '../server/machine-power/broker-acl';
import { loadMachinePowerBindings } from '../server/machine-power/config';

const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument !== '--check')) {
  throw new Error('Usage: bun scripts/generate-machine-power-mqtt-acl.ts [--check]');
}

const root = resolve(
  process.env.PROJECT_SPACE_MACHINE_POWER_CONFIG_ROOT ??
    resolve(process.cwd(), 'config/machine-power')
);
const output = resolve(process.cwd(), 'deploy/mqtt/config/acl');
const expected = renderMachinePowerBrokerAcl(await loadMachinePowerBindings(root));

if (arguments_.includes('--check')) {
  const current = await readFile(output, 'utf8');
  if (current !== expected) {
    throw new Error(
      'deploy/mqtt/config/acl is stale. Run bun run machine-power:mqtt-acl:generate.'
    );
  }
} else {
  await writeFile(output, expected);
}
