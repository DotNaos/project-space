import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { createCodexAuthorizationOperationPersistence } from '../server/codex-authorization/operation-store';
import { codexOperationSnapshotFileEnvironment } from '../server/codex-sessions/operation-snapshot-store';

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('Codex authorization operation store', () => {
  test('round-trips only bounded non-secret operation state for one machine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'project-codex-authorization-'));
    temporaryPaths.push(root);
    const environment = {
      [codexOperationSnapshotFileEnvironment]: join(root, 'codex-operations.json')
    };
    const store = createCodexAuthorizationOperationPersistence(environment, 'machine-wsl');
    await store.persist([{
      deadlineAt: '2026-07-24T00:15:00.000Z',
      operationId: 'codex:login:operation-one',
      state: 'ambiguous',
      updatedAt: '2026-07-24T00:01:00.000Z'
    }]);

    const restored = createCodexAuthorizationOperationPersistence(
      environment,
      'machine-wsl'
    );
    expect(restored.snapshot).toEqual([{
      deadlineAt: '2026-07-24T00:15:00.000Z',
      operationId: 'codex:login:operation-one',
      state: 'ambiguous',
      updatedAt: '2026-07-24T00:01:00.000Z'
    }]);
    const recordsDirectory = join(
      root,
      'codex-authorization-journal',
      'codex-operation-records'
    );
    const document = readFileSync(join(recordsDirectory, readdirSync(recordsDirectory)[0]!), 'utf8');
    expect(document).not.toContain('userCode');
    expect(document).not.toContain('loginId');
  });
});
