import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { MemoryMachineConnectionStore } from '../server/machine-connection-memory-store';
import {
  enrollProjectChatE2EMachine,
  writePrivateProjectChatE2ECredential
} from './project-chat-e2e-machine';

describe('Project Chat E2E machine harness', () => {
  test('enrolls a machine through the public approval and key-proof flow', async () => {
    const store = new MemoryMachineConnectionStore();
    const credential = await enrollProjectChatE2EMachine({
      backendUrl: 'http://127.0.0.1:4173',
      hostId: 'project-chat-e2e',
      store,
      userId: 'e2e-user'
    });

    const machine = await store.getMachine(credential.machineId);
    expect(machine).toMatchObject({
      hostname: 'project-chat-e2e',
      name: 'Project Chat E2E Machine',
      ownerUserId: 'e2e-user'
    });
    expect(credential).toMatchObject({
      backendUrl: 'http://127.0.0.1:4173',
      machineId: machine?.id,
      machineName: 'Project Chat E2E Machine',
      version: 'project-space.project-chat-e2e-credential/v1'
    });
    expect(credential.credential.length).toBeGreaterThan(32);
  });

  test('creates a private credential file without replacing existing files', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'project-chat-e2e-machine-'));
    const path = join(directory, 'credential.json');
    const credential = {
      backendUrl: 'http://127.0.0.1:4173',
      credential: 'private-machine-credential',
      issuedAt: '2026-07-11T00:00:00.000Z',
      machineId: 'machine-id',
      machineName: 'Project Chat E2E Machine',
      version: 'project-space.project-chat-e2e-credential/v1' as const
    };

    try {
      await writePrivateProjectChatE2ECredential(path, credential);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(credential);

      await expect(
        writePrivateProjectChatE2ECredential(path, {
          ...credential,
          credential: 'replacement-secret'
        })
      ).rejects.toThrow();
      expect(await readFile(path, 'utf8')).not.toContain('replacement-secret');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test('does not follow an existing credential-file symlink', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'project-chat-e2e-machine-'));
    const target = join(directory, 'target.json');
    const link = join(directory, 'credential.json');
    await writeFile(target, 'unchanged', { mode: 0o600 });
    await symlink(target, link);

    try {
      await expect(
        writePrivateProjectChatE2ECredential(link, {
          backendUrl: 'http://127.0.0.1:4173',
          credential: 'private-machine-credential',
          issuedAt: '2026-07-11T00:00:00.000Z',
          machineId: 'machine-id',
          machineName: 'Project Chat E2E Machine',
          version: 'project-space.project-chat-e2e-credential/v1'
        })
      ).rejects.toThrow();
      expect(await readFile(target, 'utf8')).toBe('unchanged');
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
