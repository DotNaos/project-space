import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';

import {
  connectorRuntimeCredentialVersion,
  connectorRuntimeProtocolEnvironment
} from '../server/connector-runtime-credential';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

async function waitForOutput(
  output: { value: string },
  expected: string,
  timeoutMs = 5_000
) {
  const startedAt = Date.now();
  while (!output.value.includes(expected)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for web-server output: ${output.value}`);
    }
    await Bun.sleep(10);
  }
}

describe('web server authenticated runtime mode', () => {
  test('starts only the stdin-authenticated connector companion', async () => {
    const credential = 'runtime-credential-that-must-stay-on-stdin';
    const child = spawn(process.execPath, ['server/web-server.ts'], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DATABASE_URL: 'postgres://must-not-connect.invalid/project-space',
        PROJECT_SPACE_LOG_LEVEL: 'info',
        PROJECT_SPACE_PUBLIC_ORIGIN: 'https://projects.os-home.net',
        [connectorRuntimeProtocolEnvironment]: connectorRuntimeCredentialVersion
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = { value: '' };
    const stderr = { value: '' };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout.value += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr.value += chunk;
    });
    child.stdin.end(JSON.stringify({
      backendUrl: 'http://127.0.0.1:1',
      credential,
      machineId: 'runtime-entrypoint-machine',
      version: connectorRuntimeCredentialVersion
    }));

    try {
      await waitForOutput(
        stdout,
        '"event":"server.started"'
      );
      expect(stdout.value).toContain('"mode":"authenticated-machine-connector"');
      expect(stdout.value).not.toContain('fullstack server running');
      expect(stdout.value).not.toContain(credential);
      expect(stderr.value).not.toContain(credential);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    }

    expect(child.exitCode).toBe(0);
  }, 10_000);
});
