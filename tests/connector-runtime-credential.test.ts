import { Readable } from 'node:stream';
import { describe, expect, test } from 'bun:test';

import {
  connectorRuntimeCredentialVersion,
  connectorRuntimeProtocolEnvironment,
  readConnectorRuntimeCredential
} from '../server/connector-runtime-credential';

const runtimeCredential = {
  backendUrl: 'https://projects.os-home.net',
  credential: 'runtime-machine-secret',
  machineId: 'machine-123',
  version: connectorRuntimeCredentialVersion
};

function input(value: string) {
  return Readable.from([value]);
}

const enabled = {
  [connectorRuntimeProtocolEnvironment]: connectorRuntimeCredentialVersion
};

describe('connector runtime credential stdin contract', () => {
  test('reads only the minimal versioned credential when the supervisor marker is present', async () => {
    await expect(
      readConnectorRuntimeCredential(input(JSON.stringify(runtimeCredential)), enabled)
    ).resolves.toEqual(runtimeCredential);
  });

  test('does not consume stdin outside supervisor mode', async () => {
    await expect(
      readConnectorRuntimeCredential(input('not-json'), {})
    ).resolves.toBeNull();
  });

  test('rejects unknown fields, insecure origins, and oversized input without echoing secrets', async () => {
    const cases = [
      { ...runtimeCredential, privateKey: 'must-never-enter-connector' },
      { ...runtimeCredential, backendUrl: 'http://remote.example.test' },
      'x'.repeat(16 * 1024 + 1)
    ];
    for (const candidate of cases) {
      const serialized = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
      try {
        await readConnectorRuntimeCredential(input(serialized), enabled);
        throw new Error('Expected unsafe runtime credential to fail.');
      } catch (error) {
        expect(String(error)).not.toContain(runtimeCredential.credential);
        expect(String(error)).not.toContain('must-never-enter-connector');
      }
    }
  });
});
