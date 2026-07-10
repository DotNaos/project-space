import { afterEach, describe, expect, test } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createLocalProjectSpaceBackend } from '../server/local-project-space-backend';

const testDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(testDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function localMachineId() {
  const backend = createLocalProjectSpaceBackend();
  const overview = await backend.getConnectorOverview();
  const machine = overview.machines.find(
    (entry) => entry.connector.status === 'local' || entry.kind === 'local'
  );
  if (!machine) {
    throw new Error('Local machine is missing from the test connector registry.');
  }
  return { backend, machineId: machine.id };
}

describe('machine filesystem', () => {
  test('lists and reads regular files inside home', async () => {
    const directory = await mkdtemp(join(homedir(), '.project-space-explorer-test-'));
    testDirectories.push(directory);
    await mkdir(join(directory, 'nested'));
    await writeFile(join(directory, 'note.txt'), 'hello\nworld');

    const { backend, machineId } = await localMachineId();
    const listing = await backend.readMachineDirectory({ machineId, path: directory });
    expect(listing.status).toBe('success');
    expect(listing.entries.map((entry) => [entry.kind, entry.name])).toEqual([
      ['directory', 'nested'],
      ['file', 'note.txt']
    ]);
    expect(listing.entries.find((entry) => entry.name === 'note.txt')?.sizeBytes).toBe(11);

    const file = await backend.readMachineFile({ machineId, path: join(directory, 'note.txt') });
    expect(file.status).toBe('success');
    expect(file.content).toBe('hello\nworld');
  });

  test('rejects missing, binary, and home-escaping paths', async () => {
    const directory = await mkdtemp(join(homedir(), '.project-space-explorer-test-'));
    testDirectories.push(directory);
    await writeFile(join(directory, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(directory, 'large.txt'), Buffer.alloc(256 * 1024 + 1, 65));
    await writeFile(join(directory, 'many-lines.txt'), `${'line\n'.repeat(6_000)}end`);
    await symlink(tmpdir(), join(directory, 'outside-link'));

    const { backend, machineId } = await localMachineId();
    const binary = await backend.readMachineFile({ machineId, path: join(directory, 'binary.dat') });
    expect(binary.errorCode).toBe('unsupported');

    const large = await backend.readMachineFile({ machineId, path: join(directory, 'large.txt') });
    expect(large.errorCode).toBe('too-large');

    const manyLines = await backend.readMachineFile({
      machineId,
      path: join(directory, 'many-lines.txt')
    });
    expect(manyLines.status).toBe('success');
    expect(manyLines.truncated).toBe(true);
    expect(manyLines.content?.split('\n')).toHaveLength(5_000);

    const missing = await backend.readMachineDirectory({ machineId, path: join(directory, 'missing') });
    expect(missing.errorCode).toBe('not-found');

    const directEscape = await backend.readMachineDirectory({ machineId, path: tmpdir() });
    expect(directEscape.errorCode).toBe('outside-home');

    const symlinkEscape = await backend.readMachineDirectory({
      machineId,
      path: join(directory, 'outside-link')
    });
    expect(symlinkEscape.errorCode).toBe('outside-home');
  });
});
