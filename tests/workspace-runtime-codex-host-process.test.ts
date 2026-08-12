import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { expect, test } from 'bun:test';

test('runs the real host process over bounded private stdio without a listener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'project-runtime-codex-process-'));
  const fakeCodex = resolve('tests/fixtures/fake-codex-app-server.ts');
  await chmod(fakeCodex, 0o700);
  const bootstrapPath = join(directory, 'bootstrap.json');
  await writeFile(bootstrapPath, JSON.stringify({
    binaryPath: fakeCodex,
    codexHome: join(directory, 'codex'),
    environmentId: '11111111-1111-4111-8111-111111111111',
    generation: '22222222-2222-4222-8222-222222222222',
    journalPath: join(directory, 'host-journal.json'),
    operationSnapshotPath: join(directory, 'codex-operations.json'),
    ownerUserId: 'user_owner',
    workspaceId: 'ws_0123456789abcdef01234567'
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [
    'server/workspace-runtime-codex-host/cli.ts',
    '--bootstrap',
    bootstrapPath
  ], { stdio: 'pipe' });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const lines = createInterface({ input: child.stdout! });
  const iterator = lines[Symbol.asyncIterator]();
  expect(JSON.parse(String((await iterator.next()).value))).toMatchObject({
    capability: 'runtime.codex.v1',
    state: 'ready',
    type: 'controller.ready'
  });
  child.stdin!.write(`${JSON.stringify({
    resumeAfterEventSequence: 0,
    sessionId: 'socket-one',
    type: 'controller.bind'
  })}\n`);
  child.stdin!.write(`${JSON.stringify({
    command: {
      actorId: 'actor-owner', actorKind: 'human', actorUserId: 'user_owner',
      commandId: 'command-start', commandSequence: 1,
      environmentId: '11111111-1111-4111-8111-111111111111',
      generation: '22222222-2222-4222-8222-222222222222', kind: 'runtime-start',
      operationId: 'operation.start', request: { operationId: 'operation.start' },
      schemaVersion: 1, sessionId: 'socket-one', type: 'runtime.codex.command',
      workspaceId: 'ws_0123456789abcdef01234567'
    },
    type: 'controller.command'
  })}\n`);
  const accepted = JSON.parse(String((await iterator.next()).value));
  const result = JSON.parse(String((await iterator.next()).value));
  expect(accepted).toMatchObject({
    message: { replayed: false, type: 'runtime.codex.command-accepted' },
    type: 'controller.message'
  });
  expect(result).toMatchObject({
    message: { result: { state: 'ready' }, type: 'runtime.codex.result' },
    type: 'controller.message'
  });
  child.stdin!.write('{"type":"controller.stop"}\n');
  expect(JSON.parse(String((await iterator.next()).value))).toEqual({
    state: 'stopped', type: 'controller.stopped'
  });
  expect(await exited).toBe(0);
});
