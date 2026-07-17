import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  codexOperationSnapshotFileEnvironment,
  createCodexOperationSnapshotPersistence
} from '../server/codex-sessions/operation-snapshot-store';
import {
  CodexOperationLedger,
  CodexOperationUncertainError
} from '../server/codex-sessions/operation-ledger';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

async function snapshotPath() {
  const directory = await mkdtemp(join(tmpdir(), 'codex-operation-snapshot-'));
  temporaryDirectories.push(directory);
  return join(directory, 'codex-operations.json');
}

describe('durable Codex operation snapshots', () => {
  test('does not dispatch when the uncertain marker cannot be persisted', async () => {
    let dispatches = 0;
    const ledger = new CodexOperationLedger([], async () => {
      throw new Error('snapshot unavailable');
    });

    await expect(ledger.execute('send-no-journal', 'same-input', async () => {
      dispatches += 1;
      return { status: 'accepted' };
    })).rejects.toThrow('snapshot unavailable');
    expect(dispatches).toBe(0);
    expect(ledger.snapshot()).toEqual([]);
  });

  test('fails closed when a completed result cannot be made durable', async () => {
    let persistCalls = 0;
    const ledger = new CodexOperationLedger([], async () => {
      persistCalls += 1;
      if (persistCalls === 2) throw new Error('completion snapshot unavailable');
    });

    await expect(ledger.execute('send-completion-uncertain', 'same-input', async () => ({
      status: 'accepted'
    }))).rejects.toBeInstanceOf(CodexOperationUncertainError);
    expect(ledger.snapshot()).toEqual([
      expect.objectContaining({
        operationId: 'send-completion-uncertain',
        state: 'uncertain'
      })
    ]);
    expect(() => ledger.execute('send-completion-uncertain', 'same-input', async () => ({
      status: 'duplicate'
    }))).toThrow(CodexOperationUncertainError);
  });

  test('keeps reconciliation uncertain when its durable update fails', async () => {
    const snapshot = [{
      fingerprint: 'same-input',
      operationId: 'send-reconcile-failure',
      state: 'uncertain' as const
    }];
    const notApplied = new CodexOperationLedger(snapshot, async () => {
      throw new Error('reconciliation snapshot unavailable');
    });
    await expect(notApplied.reconcileNotApplied('send-reconcile-failure'))
      .rejects.toThrow('reconciliation snapshot unavailable');
    expect(() => notApplied.execute('send-reconcile-failure', 'same-input', async () => ({
      status: 'duplicate'
    }))).toThrow(CodexOperationUncertainError);

    const completed = new CodexOperationLedger(snapshot, async () => {
      throw new Error('reconciliation snapshot unavailable');
    });
    await expect(completed.reconcileCompleted('send-reconcile-failure', {
      status: 'accepted'
    })).rejects.toThrow('reconciliation snapshot unavailable');
    expect(() => completed.execute('send-reconcile-failure', 'same-input', async () => ({
      status: 'duplicate'
    }))).toThrow(CodexOperationUncertainError);
  });

  test('replays a completed operation after the connector process is recreated', async () => {
    const path = await snapshotPath();
    const environment = { [codexOperationSnapshotFileEnvironment]: path };
    const firstPersistence = createCodexOperationSnapshotPersistence(environment);
    const first = new CodexOperationLedger(
      firstPersistence.snapshot,
      firstPersistence.persist
    );

    expect(await first.execute('send-restart-safe', 'same-input', async () => ({
      status: 'accepted',
      turnId: 'turn-one'
    }))).toEqual({ status: 'accepted', turnId: 'turn-one' });

    const restartedPersistence = createCodexOperationSnapshotPersistence(environment);
    const restarted = new CodexOperationLedger(
      restartedPersistence.snapshot,
      restartedPersistence.persist
    );
    let duplicateExecutions = 0;
    expect(await restarted.execute('send-restart-safe', 'same-input', async () => {
      duplicateExecutions += 1;
      return { status: 'accepted', turnId: 'turn-duplicate' };
    })).toEqual({ status: 'accepted', turnId: 'turn-one' });
    expect(duplicateExecutions).toBe(0);
    expect((await lstat(path)).mode & 0o077).toBe(0);
  });

  test('restores an operation interrupted mid-dispatch as uncertain instead of repeating it', async () => {
    const path = await snapshotPath();
    const environment = { [codexOperationSnapshotFileEnvironment]: path };
    const persistence = createCodexOperationSnapshotPersistence(environment);
    const first = new CodexOperationLedger(persistence.snapshot, persistence.persist);
    let finish!: (value: { status: string }) => void;
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => { started = resolve; });
    const actionFinished = new Promise<{ status: string }>((resolve) => { finish = resolve; });
    const pending = first.execute('send-interrupted', 'same-input', async () => {
      started();
      return actionFinished;
    });
    await actionStarted;

    const document = JSON.parse(await readFile(path, 'utf8')) as {
      operations: Array<{ operationId: string; state: string }>;
    };
    expect(document.operations).toContainEqual(expect.objectContaining({
      operationId: 'send-interrupted',
      state: 'uncertain'
    }));

    const restartedPersistence = createCodexOperationSnapshotPersistence(environment);
    const restarted = new CodexOperationLedger(
      restartedPersistence.snapshot,
      restartedPersistence.persist
    );
    let duplicateExecutions = 0;
    expect(() => restarted.execute('send-interrupted', 'same-input', async () => {
      duplicateExecutions += 1;
      return { status: 'accepted' };
    })).toThrow(CodexOperationUncertainError);
    expect(duplicateExecutions).toBe(0);

    finish({ status: 'accepted' });
    await pending;
  });
});
