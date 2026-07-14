import { describe, expect, test } from 'bun:test';

import {
  clearIssueCreationUncertainty,
  loadIssueCreationUncertainty,
  saveIssueCreationUncertainty
} from '../src/features/project-desktop/components/issue-creation-uncertainty';

const REPOSITORY = 'DotNaos/project-space';
const OPERATION = '00000000-0000-4000-8000-000000000001';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
    values
  };
}

describe('issue creation uncertainty persistence', () => {
  test('restores a scoped uncertain draft with its original operation', () => {
    const storage = memoryStorage();
    const record = {
      body: 'Body without local attachment placeholders',
      operationId: OPERATION,
      repositoryKey: REPOSITORY,
      selectedLabels: ['bug', 'bug'],
      title: 'Maybe created'
    };

    expect(saveIssueCreationUncertainty(record, storage)).toBe(true);
    expect(loadIssueCreationUncertainty(REPOSITORY, storage)).toEqual({
      ...record,
      selectedLabels: ['bug']
    });
    expect(loadIssueCreationUncertainty('DotNaos/other', storage)).toBeNull();
  });

  test('clears only the matching operation and removes malformed records', () => {
    const storage = memoryStorage();
    saveIssueCreationUncertainty({
      body: '',
      operationId: OPERATION,
      repositoryKey: REPOSITORY,
      selectedLabels: [],
      title: 'Maybe created'
    }, storage);

    expect(clearIssueCreationUncertainty(REPOSITORY, crypto.randomUUID(), storage)).toBe(false);
    expect(loadIssueCreationUncertainty(REPOSITORY, storage)?.operationId).toBe(OPERATION);
    expect(clearIssueCreationUncertainty(REPOSITORY, OPERATION, storage)).toBe(true);
    expect(loadIssueCreationUncertainty(REPOSITORY, storage)).toBeNull();

    storage.setItem(
      'project-space:issue-creation-uncertainty:v1:DotNaos/project-space',
      JSON.stringify({ operationId: OPERATION })
    );
    expect(loadIssueCreationUncertainty(REPOSITORY, storage)).toBeNull();
    expect(storage.values.size).toBe(0);
  });
});
