import { afterEach, describe, expect, test } from 'bun:test';

import {
  clearCodexTaskStartAttempt,
  readOrCreateCodexTaskStartAttempt
} from '../src/features/project-desktop/components/codex-task-start-attempt';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value)
  }
});

const input = {
  connectorId: 'connector-one',
  expectedBranch: 'issue-442-filter-url',
  expectedCommit: 'a'.repeat(40),
  issue: 442,
  physicalMachineId: 'machine-one',
  repositoryId: 'DotNaos/project-space'
};

afterEach(() => values.clear());

describe('Codex task start attempts', () => {
  test('reuses the original operation and exact revision until it is cleared', () => {
    const first = readOrCreateCodexTaskStartAttempt(input, () => 'task:first');
    const retry = readOrCreateCodexTaskStartAttempt({
      ...input,
      expectedCommit: 'b'.repeat(40)
    }, () => 'task:second');

    expect(first.operationId).toBe('task:first');
    expect(retry).toEqual(first);

    clearCodexTaskStartAttempt(input);
    expect(readOrCreateCodexTaskStartAttempt(input, () => 'task:third').operationId)
      .toBe('task:third');
  });

  test('keeps attempts isolated by physical machine', () => {
    const first = readOrCreateCodexTaskStartAttempt(input, () => 'task:first');
    const second = readOrCreateCodexTaskStartAttempt({
      ...input,
      physicalMachineId: 'machine-two'
    }, () => 'task:second');

    expect(first.operationId).toBe('task:first');
    expect(second.operationId).toBe('task:second');
  });
});
