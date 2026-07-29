export type PrototypeReviewLocalUnavailableReason =
  | 'checkout-unavailable'
  | 'codex-unavailable'
  | 'missing-thread'
  | 'repository-mismatch'
  | 'task-mismatch';

export type PrototypeReviewLocalCheckout =
  | {
      headSha: string;
      repositoryFullName: string;
      state: 'available';
    }
  | {
      reason: PrototypeReviewLocalUnavailableReason;
      state: 'unavailable';
    };

export type PrototypeReviewLocalCodex =
  | {
      machineId: string;
      machineName: string;
      state: 'available';
      threadId: string;
    }
  | {
      reason: PrototypeReviewLocalUnavailableReason;
      state: 'unavailable';
    };

export interface PrototypeReviewLocalContext {
  checkedAt: string;
  checkout: PrototypeReviewLocalCheckout;
  codex: PrototypeReviewLocalCodex;
}
