import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { connectorRuntimeRecord } from '../server/connector-build-info';
import {
  connectorRuntimeReadinessSchema,
  publishConnectorRuntimeReadiness
} from '../server/connector-runtime-readiness';
import type { ConnectorProjectRegistryResult } from '../src/shared/project-space-api';

const buildId = 'a'.repeat(40);
const attemptNonce = '1'.repeat(64);

function environment(path: string): NodeJS.ProcessEnv {
  return {
    PROJECT_CONNECTOR_READY_FILE: path,
    PROJECT_CONNECTOR_READY_ATTEMPT_NONCE: attemptNonce,
    PROJECT_SPACE_BUILD_ID: buildId,
    PROJECT_SPACE_RELEASE_ID: 'v0.4.1'
  };
}

function registry(
  machineId: string,
  runtime = connectorRuntimeRecord(environment('/tmp/connector-ready.json'))
): ConnectorProjectRegistryResult {
  return {
    checkedAt: new Date().toISOString(),
    connector: { machineId, machineName: machineId, runtime },
    discovery: {
      groups: [], projects: [], rootItems: [], rootPath: '/tmp', structureViolations: []
    }
  };
}

describe('connector runtime reconnect readiness', () => {
  test('atomically publishes a private proof for the authenticated exact build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'connector-readiness-'));
    const path = join(root, 'private', 'connector-ready.json');
    const configured = environment(path);

    expect(await publishConnectorRuntimeReadiness(
      registry('machine-191', connectorRuntimeRecord(configured)),
      'machine-191',
      configured
    )).toBe(true);

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schema: connectorRuntimeReadinessSchema,
      machineId: 'machine-191',
      buildId,
      releaseId: 'v0.4.1',
      attemptNonce
    });
    expect((await lstat(path)).mode & 0o077).toBe(0);
    expect((await lstat(join(root, 'private'))).mode & 0o077).toBe(0);
  });

  test('replaces stale evidence only after the matching build is ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'connector-readiness-stale-'));
    const path = join(root, 'connector-ready.json');
    await writeFile(path, '{"stale":true}\n', { mode: 0o600 });
    const configured = environment(path);

    await publishConnectorRuntimeReadiness(
      registry('machine-191', connectorRuntimeRecord(configured)),
      'machine-191',
      configured
    );
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      machineId: 'machine-191', buildId, releaseId: 'v0.4.1', attemptNonce
    });
  });

  test('rejects a wrong authenticated machine or advertised build', async () => {
    for (const [name, registered, authenticated] of [
      ['machine', registry('machine-other'), 'machine-191'],
      [
        'build',
        registry('machine-191', {
          ...connectorRuntimeRecord(environment('/tmp/connector-ready.json')),
          buildId: 'b'.repeat(40)
        }),
        'machine-191'
      ]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `connector-readiness-${name}-`));
      const path = join(root, 'connector-ready.json');
      await expect(
        publishConnectorRuntimeReadiness(registered, authenticated, environment(path))
      ).rejects.toThrow('does not match the authenticated build');
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('does nothing when the trusted supervisor did not provide a fixed path', async () => {
    expect(await publishConnectorRuntimeReadiness(registry('machine-191'), 'machine-191', {}))
      .toBe(false);
  });

  test('rejects incomplete or non-random supervisor attempt configuration', async () => {
    for (const configured of [
      { PROJECT_CONNECTOR_READY_FILE: '/tmp/connector-ready.json' },
      { PROJECT_CONNECTOR_READY_ATTEMPT_NONCE: attemptNonce },
      {
        PROJECT_CONNECTOR_READY_FILE: '/tmp/connector-ready.json',
        PROJECT_CONNECTOR_READY_ATTEMPT_NONCE: 'browser-selected-attempt'
      }
    ]) {
      await expect(
        publishConnectorRuntimeReadiness(
          registry('machine-191'),
          'machine-191',
          configured
        )
      ).rejects.toThrow('configuration is invalid');
    }
  });
});
