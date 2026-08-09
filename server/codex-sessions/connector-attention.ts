import type {
  CodexSessionApprovalRequest,
  CodexSessionAttentionRequest
} from '../../src/shared/codex-sessions-api';
import type { CodexRpcId } from './contracts';

export interface CodexPendingRequest {
  canAllow?: boolean;
  method: string;
  publicRequest?: CodexSessionAttentionRequest;
  requestId: CodexRpcId;
  threadId: string;
  turnId?: string;
}

export function pendingAttentionSnapshot(
  pending: Iterable<CodexPendingRequest>,
  threadId: string
) {
  const pendingRequests = [...pending]
    .filter((request) => request.threadId === threadId && request.publicRequest)
    .map((request) => request.publicRequest!);
  const attention = pendingRequests.some(({ type }) => type === 'user-input-requested')
    ? 'input' as const
    : pendingRequests.length > 0
      ? 'approval' as const
      : undefined;
  return { attention, pendingRequests };
}

export function approvalMatchesPending(
  request: CodexSessionApprovalRequest,
  pending: CodexPendingRequest
) {
  const approval = pending.publicRequest?.type === 'approval-requested'
    ? pending.publicRequest
    : undefined;
  return Boolean(approval && request.approvalId === approval.approvalId &&
    request.itemId === approval.itemId);
}
