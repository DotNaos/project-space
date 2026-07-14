import {
  type GitHubIssueAttachmentResult,
  type UploadGitHubIssueAttachmentRequest
} from '../../../api/github-issue-attachment-client';
import {
  hasUnresolvedIssueAttachments,
  type IssueAttachmentAction,
  type IssueAttachmentState
} from './issue-attachment-model';

export interface IssueAttachmentUploadResult {
  completed: boolean;
  markdown: string;
}

export type IssueAttachmentUpload = (
  request: UploadGitHubIssueAttachmentRequest,
  options: { signal: AbortSignal }
) => Promise<GitHubIssueAttachmentResult>;

export interface RunPendingIssueAttachmentUploadsOptions {
  apply(action: IssueAttachmentAction): IssueAttachmentState;
  createRequestId(): string;
  getImage(attachmentId: string): Blob | undefined;
  getState(): IssueAttachmentState;
  isCurrentRepository(repositoryKey: string): boolean;
  registerAbortController(
    attachmentId: string,
    controller: AbortController | null
  ): void;
  repositoryKey: string;
  timeoutMs?: number;
  upload: IssueAttachmentUpload;
}

const defaultTimeoutMs = 30_000;
const fallbackUploadError = 'GitHub could not store this image. Save again to retry.';

function uploadErrorMessage(error: unknown, timedOut: boolean) {
  if (timedOut) {
    return 'GitHub took too long to store this image. Save again to retry.';
  }

  if (error instanceof Error) {
    const message = error.message.trim();
    if (message && message.length <= 240 && !/[\u0000-\u001f\u007f]/.test(message)) {
      return message;
    }
  }

  return fallbackUploadError;
}

async function waitForUpload<T>(promise: Promise<T>, signal: AbortSignal) {
  let handleAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    handleAbort = () => reject(signal.reason);
    if (signal.aborted) handleAbort();
    else signal.addEventListener('abort', handleAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', handleAbort);
  }
}

function currentPendingAttachment(
  state: IssueAttachmentState,
  repositoryKey: string,
  attempted: ReadonlySet<string>
) {
  return state.attachments.find(
    (attachment) =>
      attachment.repositoryKey === repositoryKey &&
      attachment.status !== 'uploaded' &&
      attachment.status !== 'uploading' &&
      !attempted.has(attachment.attachmentId)
  );
}

export async function runPendingIssueAttachmentUploads({
  apply,
  createRequestId,
  getImage,
  getState,
  isCurrentRepository,
  registerAbortController,
  repositoryKey,
  timeoutMs = defaultTimeoutMs,
  upload
}: RunPendingIssueAttachmentUploadsOptions): Promise<IssueAttachmentUploadResult> {
  const attempted = new Set<string>();

  while (isCurrentRepository(repositoryKey)) {
    const attachment = currentPendingAttachment(getState(), repositoryKey, attempted);
    if (!attachment) break;

    attempted.add(attachment.attachmentId);
    const requestId = createRequestId();
    apply({
      attachmentId: attachment.attachmentId,
      repositoryKey,
      requestId,
      type: 'upload-started'
    });

    const image = getImage(attachment.attachmentId);
    if (!image) {
      apply({
        attachmentId: attachment.attachmentId,
        error: 'This pasted image is no longer available. Remove it and paste it again.',
        repositoryKey,
        requestId,
        type: 'upload-failed'
      });
      continue;
    }

    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : defaultTimeoutMs
    );
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    registerAbortController(attachment.attachmentId, controller);

    try {
      const result = await waitForUpload(
        upload(
          {
            attachmentId: attachment.attachmentId,
            fullName: repositoryKey,
            image
          },
          { signal }
        ),
        signal
      );

      if (timeoutSignal.aborted) {
        throw timeoutSignal.reason;
      }
      if (!isCurrentRepository(repositoryKey) || signal.aborted) continue;
      if (result.status !== 'connected' || !result.markdownUrl) {
        throw new Error(result.message || fallbackUploadError);
      }

      apply({
        attachmentId: attachment.attachmentId,
        markdownUrl: result.markdownUrl,
        repositoryKey,
        requestId,
        type: 'upload-succeeded'
      });
    } catch (error) {
      if (!isCurrentRepository(repositoryKey) || (controller.signal.aborted && !timeoutSignal.aborted)) {
        continue;
      }
      apply({
        attachmentId: attachment.attachmentId,
        error: uploadErrorMessage(error, timeoutSignal.aborted),
        repositoryKey,
        requestId,
        type: 'upload-failed'
      });
    } finally {
      registerAbortController(attachment.attachmentId, null);
    }
  }

  const state = getState();
  return {
    completed:
      state.repositoryKey === repositoryKey && !hasUnresolvedIssueAttachments(state),
    markdown: state.markdown
  };
}
