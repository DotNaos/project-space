import type { CodexSessionOperationResult } from '@/shared/codex-sessions-api';

export interface PrototypeReviewCodexDelivery {
  accepted: boolean;
  message?: string;
  reconnect: boolean;
}

export function prototypeReviewCodexDelivery(
  result: CodexSessionOperationResult
): PrototypeReviewCodexDelivery {
  if (result.status === 'accepted' || result.status === 'completed') {
    return { accepted: true, reconnect: false };
  }
  if (result.status === 'ambiguous') {
    return {
      accepted: false,
      message:
        'Sending could not be confirmed. Your message is still here and can be retried safely.',
      reconnect: true
    };
  }
  if (result.reason === 'thread_active') {
    return {
      accepted: false,
      message:
        'Codex started working before this message could be sent. Your message is still here.',
      reconnect: true
    };
  }
  return {
    accepted: false,
    message: 'Codex did not accept this message. Your message is still here.',
    reconnect: true
  };
}
