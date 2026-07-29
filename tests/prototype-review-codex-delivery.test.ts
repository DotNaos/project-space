import { describe, expect, test } from 'bun:test';

import { prototypeReviewCodexDelivery } from '../src/features/pr-preview-review/prototype-review-codex-delivery';
import type { CodexSessionOperationResult } from '../src/shared/codex-sessions-api';

function result(
  status: CodexSessionOperationResult['status'],
  reason?: CodexSessionOperationResult['reason']
): CodexSessionOperationResult {
  return {
    operationId: 'operation-1',
    ...(reason ? { reason } : {}),
    replayed: false,
    status,
    threadId: '019fa483-564c-7b01-9d89-5f8ef37af7d0'
  };
}

describe('prototype review Codex delivery', () => {
  test('clears a draft only after a confirmed handoff', () => {
    expect(prototypeReviewCodexDelivery(result('accepted'))).toEqual({
      accepted: true,
      reconnect: false
    });
    expect(prototypeReviewCodexDelivery(result('completed'))).toEqual({
      accepted: true,
      reconnect: false
    });
  });

  test('keeps the draft and reconnects after an unconfirmed handoff', () => {
    const ambiguous = prototypeReviewCodexDelivery(result('ambiguous'));
    const busy = prototypeReviewCodexDelivery(result('rejected', 'thread_active'));

    expect(ambiguous).toMatchObject({ accepted: false, reconnect: true });
    expect(ambiguous.message).toContain('still here');
    expect(busy).toMatchObject({ accepted: false, reconnect: true });
    expect(busy.message).toContain('still here');
  });
});
