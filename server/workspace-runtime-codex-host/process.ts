import { createInterface } from 'node:readline';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { WorkspaceRuntimeCodexHostController } from './controller';

const maximumBootstrapBytes = 32 * 1024;
const maximumMessageBytes = 64 * 1024;

interface HostBootstrap {
  binaryPath: string;
  codexHome: string;
  environmentId: string;
  generation: string;
  journalPath: string;
  operationSnapshotPath: string;
  ownerUserId: string;
  workspaceId: string;
}

export async function runWorkspaceRuntimeCodexHost(path: string) {
  const bootstrap = await readBootstrap(path);
  const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const controller = new WorkspaceRuntimeCodexHostController({
    ...bootstrap,
    emit: (message) => write({ message, type: 'controller.message' })
  });
  const ready = await controller.start();
  write({ ...ready, type: 'controller.ready' });
  const input = createInterface({ crlfDelay: Infinity, input: process.stdin });
  let tail = Promise.resolve();
  input.on('line', (line) => {
    tail = tail.then(async () => {
      if (Buffer.byteLength(line) > maximumMessageBytes) throw new Error('invalid');
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === 'controller.bind') {
        controller.bind(String(message.sessionId), Number(message.resumeAfterEventSequence));
        return;
      }
      if (message.type === 'controller.command') {
        await controller.command(message.command);
        return;
      }
      if (message.type === 'controller.stop' && Object.keys(message).length === 1) {
        await controller.stop();
        write({ state: 'stopped', type: 'controller.stopped' });
        input.close();
        return;
      }
      throw new Error('invalid');
    }).catch(() => {
      write({ code: 'invalid_message', type: 'controller.error' });
      input.close();
      process.exitCode = 1;
    });
  });
  await new Promise<void>((resolve) => input.once('close', resolve));
  await tail;
  await controller.stop();
}

async function readBootstrap(path: string): Promise<HostBootstrap> {
  if (!isAbsolute(path)) throw new Error('The Codex host bootstrap path is invalid.');
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > maximumBootstrapBytes ||
      process.platform !== 'win32' && (status.mode & 0o077) !== 0) {
    throw new Error('The Codex host bootstrap is not protected.');
  }
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const expected = [
    'binaryPath', 'codexHome', 'environmentId', 'generation', 'journalPath',
    'operationSnapshotPath', 'ownerUserId', 'workspaceId'
  ];
  if (Object.keys(value).sort().join('\0') !== expected.sort().join('\0') ||
      expected.some((key) => typeof value[key] !== 'string' || !String(value[key]))) {
    throw new Error('The Codex host bootstrap is invalid.');
  }
  for (const key of ['binaryPath', 'codexHome', 'journalPath', 'operationSnapshotPath']) {
    if (!isAbsolute(String(value[key]))) throw new Error('The Codex host bootstrap is invalid.');
  }
  return value as unknown as HostBootstrap;
}
