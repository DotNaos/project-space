import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent
} from 'react';

import { uploadGitHubIssueAttachment } from '../../../api/github-issue-attachment-client';
import {
  ISSUE_ATTACHMENT_DRAFT_MAX_COUNT,
  clipboardIssueAttachmentImages,
  prepareIssueAttachmentPasteLayout,
  selectPastedIssueAttachmentImages
} from './issue-attachment-paste';
import { IssueAttachmentLifecycle } from './issue-attachment-lifecycle';
import {
  createInitialIssueAttachmentState,
  hasUnresolvedIssueAttachments,
  issueAttachmentMarkdownWithUploadedAttachments,
  issueAttachmentMarkdownWithoutAttachments,
  issueAttachmentReducer,
  projectSpaceIssueAttachmentUrls,
  type IssueAttachmentAction,
  type IssueAttachmentState
} from './issue-attachment-model';
import {
  runPendingIssueAttachmentUploads,
  type IssueAttachmentUpload,
  type IssueAttachmentUploadResult
} from './issue-attachment-upload-controller';

export interface QueueIssueAttachmentImagesResult {
  acceptedCount: number;
  error: string | null;
  markdown: string;
  selectionEnd: number;
}

export interface UseIssueAttachmentsOptions {
  createAttachmentId?: () => string;
  createRequestId?: () => string;
  markdown: string;
  onMarkdownChange(markdown: string): void;
  repositoryKey: string | null;
  timeoutMs?: number;
  upload?: IssueAttachmentUpload;
  writeDenied?: boolean;
}

function createBrowserPreviewUrl(image: Blob) {
  if (typeof globalThis.URL?.createObjectURL !== 'function') {
    throw new Error('Image previews are unavailable in this browser.');
  }
  return globalThis.URL.createObjectURL(image);
}

function revokeBrowserPreviewUrl(url: string) {
  globalThis.URL?.revokeObjectURL?.(url);
}

function normalizedRepositoryKey(repositoryKey: string | null) {
  return repositoryKey?.trim() || null;
}

function createUuid() {
  if (!globalThis.crypto?.randomUUID) {
    throw new Error('This browser cannot prepare a secure image attachment identifier.');
  }
  return globalThis.crypto.randomUUID();
}

function restoreSelection(textarea: HTMLTextAreaElement, selectionEnd: number) {
  const restore = () => {
    try {
      textarea.setSelectionRange(selectionEnd, selectionEnd);
    } catch {
      // The editor may have closed before the next frame.
    }
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(restore);
  } else {
    queueMicrotask(restore);
  }
}

export function useIssueAttachments({
  createAttachmentId = createUuid,
  createRequestId = createUuid,
  markdown,
  onMarkdownChange,
  repositoryKey,
  timeoutMs,
  upload = uploadGitHubIssueAttachment,
  writeDenied = false
}: UseIssueAttachmentsOptions) {
  const desiredRepositoryKey = normalizedRepositoryKey(repositoryKey);
  const [state, setState] = useState<IssueAttachmentState>(() =>
    createInitialIssueAttachmentState({ markdown, repositoryKey: desiredRepositoryKey })
  );
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [attachmentLifecycle, setAttachmentLifecycle] = useState(() => ({
    previewUrls: {} as Readonly<Record<string, string>>,
    retainedStoredAttachmentCount: 0
  }));
  const stateRef = useRef(state);
  const repositoryKeyRef = useRef(desiredRepositoryKey);
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  const uploadRef = useRef(upload);
  const createAttachmentIdRef = useRef(createAttachmentId);
  const createRequestIdRef = useRef(createRequestId);
  const writeDeniedRef = useRef(writeDenied);
  const imagesRef = useRef(new Map<string, Blob>());
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const uploadPromiseRef = useRef<Promise<IssueAttachmentUploadResult> | null>(null);
  const attachmentLifecycleRef = useRef<IssueAttachmentLifecycle | null>(null);
  if (!attachmentLifecycleRef.current) {
    attachmentLifecycleRef.current = new IssueAttachmentLifecycle(
      {
        createObjectUrl: createBrowserPreviewUrl,
        revokeObjectUrl: revokeBrowserPreviewUrl
      },
      ISSUE_ATTACHMENT_DRAFT_MAX_COUNT
    );
    attachmentLifecycleRef.current.setBaselineStoredAttachmentUrls(
      projectSpaceIssueAttachmentUrls(markdown, desiredRepositoryKey)
    );
  }

  repositoryKeyRef.current = desiredRepositoryKey;
  onMarkdownChangeRef.current = onMarkdownChange;
  uploadRef.current = upload;
  createAttachmentIdRef.current = createAttachmentId;
  createRequestIdRef.current = createRequestId;
  writeDeniedRef.current = writeDenied;

  const syncAttachmentLifecycle = useCallback(() => {
    setAttachmentLifecycle(attachmentLifecycleRef.current!.snapshot());
  }, []);

  const apply = useCallback((action: IssueAttachmentAction, notify = true) => {
    const previous = stateRef.current;
    const next = issueAttachmentReducer(previous, action);
    if (next === previous) return previous;

    const nextById = new Map(
      next.attachments.map((attachment) => [attachment.attachmentId, attachment])
    );
    for (const attachment of previous.attachments) {
      const nextAttachment = nextById.get(attachment.attachmentId);
      if (!nextAttachment || nextAttachment.status === 'uploaded') {
        imagesRef.current.delete(attachment.attachmentId);
      }
      if (!nextAttachment) {
        abortControllersRef.current.get(attachment.attachmentId)?.abort();
        abortControllersRef.current.delete(attachment.attachmentId);
      }
    }
    if (
      attachmentLifecycleRef.current!.observeTransition(
        previous.attachments,
        next.attachments
      )
    ) {
      syncAttachmentLifecycle();
    }
    if (
      attachmentLifecycleRef.current!.observeStoredAttachmentUrls(
        projectSpaceIssueAttachmentUrls(next.markdown, next.repositoryKey)
      )
    ) {
      syncAttachmentLifecycle();
    }

    stateRef.current = next;
    setState(next);
    if (notify && next.markdown !== previous.markdown) {
      onMarkdownChangeRef.current(next.markdown);
    }
    return next;
  }, [syncAttachmentLifecycle]);

  const abortAll = useCallback(() => {
    for (const controller of abortControllersRef.current.values()) controller.abort();
    abortControllersRef.current.clear();
  }, []);

  useEffect(() => {
    const current = stateRef.current;
    if (current.repositoryKey !== desiredRepositoryKey) {
      abortAll();
      imagesRef.current.clear();
      attachmentLifecycleRef.current!.reset();
      attachmentLifecycleRef.current!.setBaselineStoredAttachmentUrls(
        projectSpaceIssueAttachmentUrls(markdown, desiredRepositoryKey)
      );
      syncAttachmentLifecycle();
      setError(null);
      if (markdown !== current.markdown) {
        apply({ markdown, type: 'markdown-changed' }, false);
      }
      apply(
        { repositoryKey: desiredRepositoryKey, type: 'repository-changed' },
        true
      );
      return;
    }

    if (markdown !== current.markdown) {
      apply({ markdown, type: 'markdown-changed' }, false);
    }
  }, [abortAll, apply, desiredRepositoryKey, markdown]);

  useEffect(() => () => {
    abortAll();
    attachmentLifecycleRef.current!.reset();
  }, [abortAll]);

  const handleMarkdownChange = useCallback(
    (nextMarkdown: string) => {
      const next = apply({ markdown: nextMarkdown, type: 'markdown-changed' }, false);
      onMarkdownChangeRef.current(next.markdown);
      if (!next.attachments.some((attachment) => attachment.status === 'failed')) {
        setError(null);
      }
    },
    [apply]
  );

  const queuePastedImages = useCallback(
    (images: readonly Blob[], cursor: number): QueueIssueAttachmentImagesResult => {
      const current = stateRef.current;
      const currentRepositoryKey = repositoryKeyRef.current;
      if (writeDeniedRef.current) {
        const message =
          'This repository is read-only for files. Remove pasted images to create the issue.';
        setError(message);
        return {
          acceptedCount: 0,
          error: message,
          markdown: current.markdown,
          selectionEnd: Math.max(0, cursor)
        };
      }
      if (!currentRepositoryKey || current.repositoryKey !== currentRepositoryKey) {
        const message = 'Choose a repository before pasting an image.';
        setError(message);
        return {
          acceptedCount: 0,
          error: message,
          markdown: current.markdown,
          selectionEnd: Math.max(0, cursor)
        };
      }

      const reservedIds = new Set(
        current.attachments.map((attachment) => attachment.attachmentId)
      );
      const createUniqueAttachmentId = () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const attachmentId = createAttachmentIdRef.current();
          if (!reservedIds.has(attachmentId)) {
            reservedIds.add(attachmentId);
            return attachmentId;
          }
        }
        throw new Error('Project Space could not prepare a unique image attachment.');
      };

      let selection;
      try {
        selection = selectPastedIssueAttachmentImages({
          attachments: current.attachments,
          createAttachmentId: createUniqueAttachmentId,
          images
        });
      } catch (selectionError) {
        const message =
          selectionError instanceof Error
            ? selectionError.message
            : 'Project Space could not prepare this pasted image.';
        setError(message);
        return {
          acceptedCount: 0,
          error: message,
          markdown: current.markdown,
          selectionEnd: Math.max(0, cursor)
        };
      }

      if (selection.accepted.length === 0) {
        setError(selection.error);
        return {
          acceptedCount: 0,
          error: selection.error,
          markdown: current.markdown,
          selectionEnd: Math.max(0, cursor)
        };
      }

      const layout = prepareIssueAttachmentPasteLayout({
        attachmentIds: selection.accepted.map(({ attachmentId }) => attachmentId),
        cursor,
        markdown: current.markdown
      });
      apply({ markdown: layout.markdown, type: 'markdown-changed' }, false);

      selection.accepted.forEach(({ attachmentId, image }, index) => {
        const next = apply(
          {
            attachmentId,
            cursor: layout.insertionCursors[index],
            mediaType: image.type,
            repositoryKey: currentRepositoryKey,
            sizeBytes: image.size,
            type: 'attachment-queued'
          },
          false
        );
        if (next.attachments.some((attachment) => attachment.attachmentId === attachmentId)) {
          imagesRef.current.set(attachmentId, image);
          try {
            if (attachmentLifecycleRef.current!.addPreview(attachmentId, image)) {
              syncAttachmentLifecycle();
            }
          } catch {
            // Uploading still works when this browser cannot create a local preview URL.
          }
        }
      });

      const nextMarkdown = stateRef.current.markdown;
      onMarkdownChangeRef.current(nextMarkdown);
      setError(selection.error);
      return {
        acceptedCount: selection.accepted.length,
        error: selection.error,
        markdown: nextMarkdown,
        selectionEnd: layout.selectionEnd
      };
    },
    [apply, syncAttachmentLifecycle]
  );

  const handlePaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const images = clipboardIssueAttachmentImages(event.clipboardData);
      if (images.length === 0) return;

      event.preventDefault();
      const textarea = event.currentTarget;
      const result = queuePastedImages(images, textarea.selectionStart);
      if (result.acceptedCount > 0) {
        restoreSelection(textarea, result.selectionEnd);
      }
    },
    [queuePastedImages]
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      abortControllersRef.current.get(attachmentId)?.abort();
      abortControllersRef.current.delete(attachmentId);
      imagesRef.current.delete(attachmentId);
      const next = apply({ attachmentId, type: 'attachment-removed' });
      if (!next.attachments.some((attachment) => attachment.status === 'failed')) {
        setError(null);
      }
    },
    [apply]
  );

  const removeAllAttachments = useCallback(() => {
    const attachmentIds = stateRef.current.attachments.map(
      (attachment) => attachment.attachmentId
    );
    for (const attachmentId of attachmentIds) {
      abortControllersRef.current.get(attachmentId)?.abort();
      abortControllersRef.current.delete(attachmentId);
      imagesRef.current.delete(attachmentId);
      apply({ attachmentId, type: 'attachment-removed' }, false);
    }
    onMarkdownChangeRef.current(stateRef.current.markdown);
    setError(null);
  }, [apply]);

  const resetAttachmentLifecycle = useCallback((nextMarkdown = '') => {
    abortAll();
    imagesRef.current.clear();
    uploadPromiseRef.current = null;
    attachmentLifecycleRef.current!.reset();
    attachmentLifecycleRef.current!.setBaselineStoredAttachmentUrls(
      projectSpaceIssueAttachmentUrls(nextMarkdown, repositoryKeyRef.current)
    );
    syncAttachmentLifecycle();
    const next = createInitialIssueAttachmentState({
      markdown: nextMarkdown,
      repositoryKey: repositoryKeyRef.current
    });
    stateRef.current = next;
    setState(next);
    setError(null);
    setIsUploading(false);
  }, [abortAll, syncAttachmentLifecycle]);

  const uploadPendingAttachments = useCallback((issueNumber: number) => {
    if (uploadPromiseRef.current) return uploadPromiseRef.current;

    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      const result = Promise.resolve({
        completed: false,
        markdown: stateRef.current.markdown,
        persistableMarkdown:
          issueAttachmentMarkdownWithUploadedAttachments(stateRef.current)
      });
      setError('Create or select an issue before storing pasted images.');
      return result;
    }

    if (!hasUnresolvedIssueAttachments(stateRef.current)) {
      return Promise.resolve({
        completed: true,
        markdown: stateRef.current.markdown,
        persistableMarkdown:
          issueAttachmentMarkdownWithUploadedAttachments(stateRef.current)
      });
    }

    const currentRepositoryKey = repositoryKeyRef.current;
    if (!currentRepositoryKey || stateRef.current.repositoryKey !== currentRepositoryKey) {
      const result = Promise.resolve({
        completed: false,
        markdown: stateRef.current.markdown,
        persistableMarkdown:
          issueAttachmentMarkdownWithUploadedAttachments(stateRef.current)
      });
      setError('Choose a repository before storing pasted images.');
      return result;
    }

    const promise = (async () => {
      setIsUploading(true);
      setError(null);
      try {
        const result = await runPendingIssueAttachmentUploads({
          apply,
          createRequestId: () => createRequestIdRef.current(),
          getImage: (attachmentId) => imagesRef.current.get(attachmentId),
          getState: () => stateRef.current,
          isCurrentRepository: (key) => repositoryKeyRef.current === key,
          issueNumber,
          registerAbortController: (attachmentId, controller) => {
            if (controller) abortControllersRef.current.set(attachmentId, controller);
            else abortControllersRef.current.delete(attachmentId);
          },
          repositoryKey: currentRepositoryKey,
          timeoutMs,
          upload: (request, options) => uploadRef.current(request, options)
        });

        if (!result.completed && repositoryKeyRef.current === currentRepositoryKey) {
          setError('One or more images could not be stored. Save again to retry.');
        }
        return result;
      } finally {
        setIsUploading(false);
        uploadPromiseRef.current = null;
      }
    })();

    uploadPromiseRef.current = promise;
    return promise;
  }, [apply, timeoutMs]);

  return {
    attachments: state.attachments,
    error,
    handleMarkdownChange,
    handlePaste,
    hasUnresolvedAttachments: hasUnresolvedIssueAttachments(state),
    isUploading,
    markdown: state.markdown,
    markdownWithUploadedAttachments:
      issueAttachmentMarkdownWithUploadedAttachments(state),
    markdownWithoutAttachments: issueAttachmentMarkdownWithoutAttachments(state),
    previewUrls: attachmentLifecycle.previewUrls,
    queuePastedImages,
    resetAttachmentLifecycle,
    retainedStoredAttachmentCount:
      attachmentLifecycle.retainedStoredAttachmentCount,
    removeAllAttachments,
    removeAttachment,
    uploadPendingAttachments
  };
}

export type IssueAttachmentsController = ReturnType<typeof useIssueAttachments>;
