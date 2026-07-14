import { Button, Spinner } from '@heroui/react';
import { ImageIcon, X } from 'lucide-react';

import type { IssueAttachmentDraft } from './issue-attachment-model';

interface IssueAttachmentStatusProps {
  attachments: readonly IssueAttachmentDraft[];
  disabled?: boolean;
  error?: string | null;
  onRemove(attachmentId: string): void;
}

function formatBytes(sizeBytes: number) {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.max(1, Math.ceil(sizeBytes / 1024))} KiB`;
}

function statusText(attachment: IssueAttachmentDraft) {
  switch (attachment.status) {
    case 'queued':
      return 'Ready to store when you save';
    case 'uploading':
      return 'Storing in the repository…';
    case 'failed':
      return attachment.error;
    case 'uploaded':
      return 'Stored in the repository';
  }
}

export function IssueAttachmentStatus({
  attachments,
  disabled = false,
  error,
  onRemove
}: IssueAttachmentStatusProps) {
  if (attachments.length === 0 && !error) return null;
  const hasPendingImages = attachments.some((attachment) => attachment.status !== 'uploaded');

  return (
    <section aria-label="Pasted images" className="mt-3 border-t border-neutral-800 pt-3">
      {attachments.length > 0 ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-medium text-neutral-300">Pasted images</h3>
            <p className="text-right text-[11px] text-neutral-500">
              {attachments.length}/10 · 10 MiB each · 50 MiB total
            </p>
          </div>

          <ul className="mt-2 space-y-1.5" aria-live="polite">
            {attachments.map((attachment) => (
              <li
                key={attachment.attachmentId}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-950/60 px-2.5 py-2"
              >
                {attachment.status === 'uploading' ? (
                  <Spinner aria-label="Storing image" size="sm" />
                ) : (
                  <ImageIcon aria-hidden="true" className="size-4 shrink-0 text-neutral-500" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium text-neutral-200">Pasted image</span>
                    <span className="text-[11px] text-neutral-500">
                      {formatBytes(attachment.sizeBytes)}
                    </span>
                  </div>
                  <p
                    className={
                      attachment.status === 'failed'
                        ? 'mt-0.5 text-[11px] leading-4 text-amber-300'
                        : 'mt-0.5 text-[11px] leading-4 text-neutral-500'
                    }
                  >
                    {statusText(attachment)}
                  </p>
                </div>
                <Button
                  aria-label="Remove pasted image"
                  className="size-7 min-h-7 min-w-7 shrink-0 rounded-full p-0 text-neutral-500"
                  isIconOnly
                  isDisabled={disabled}
                  size="sm"
                  variant="ghost"
                  onPress={() => onRemove(attachment.attachmentId)}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[11px] leading-4 text-neutral-500">
            {hasPendingImages
              ? 'New images stay only in this browser until you save. Saving requires repository write access and stores each one with a commit.'
              : 'These images were stored in this repository with a commit.'}
          </p>
        </>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs leading-5 text-amber-300" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
