import { describe, expect, test } from 'bun:test';

import { CodexAttachLeaseStore } from '../server/codex-machine-tasks/attach-lease-store';

const lease = {
  callerMachineId: 'caller-one',
  connectorId: 'connector-remote',
  generation: 7,
  operationId: 'attach-operation-one',
  threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
  userId: 'user-owner'
};

describe('Codex attach leases', () => {
  test('issues a header-safe one-time token bound to the exact thread', () => {
    const store = new CodexAttachLeaseStore();
    const issued = store.issue(lease, 1_000);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.endpointPath).toBe(`/api/codex/tasks/${lease.threadId}/attach/socket`);
    expect(store.consume(issued.token, lease.threadId, 2_000))
      .toEqual(expect.objectContaining(lease));
    expect(store.consume(issued.token, lease.threadId, 2_001)).toBeUndefined();
  });

  test('fails closed for wrong-thread and expired capabilities', () => {
    const store = new CodexAttachLeaseStore();
    const wrongThread = store.issue(lease, 1_000);
    expect(store.consume(wrongThread.token, '019f6d33-6aad-7302-a45e-bb7a33fc399d', 2_000))
      .toBeUndefined();
    expect(store.consume(wrongThread.token, lease.threadId, 2_001)).toBeUndefined();

    const expired = store.issue(lease, 1_000);
    expect(store.consume(expired.token, lease.threadId, 61_000)).toBeUndefined();
  });
});
