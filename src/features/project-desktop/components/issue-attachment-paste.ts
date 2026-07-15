import {
  issueAttachmentPlaceholder,
  validateIssueAttachmentCandidate,
  type IssueAttachmentDraft
} from './issue-attachment-model';

export const ISSUE_ATTACHMENT_DRAFT_MAX_COUNT = 10;
export const ISSUE_ATTACHMENT_DRAFT_MAX_BYTES = 50 * 1024 * 1024;

export interface SelectedIssueAttachmentImage {
  attachmentId: string;
  image: Blob;
}

export interface IssueAttachmentPasteSelection {
  accepted: readonly SelectedIssueAttachmentImage[];
  error: string | null;
}

export interface IssueAttachmentPasteLayout {
  insertionCursors: readonly number[];
  markdown: string;
  selectionEnd: number;
}

function uniqueMessages(messages: readonly string[]) {
  return [...new Set(messages)].join(' ');
}

function safeCursor(markdown: string, cursor: number) {
  if (!Number.isFinite(cursor)) return markdown.length;
  return Math.min(markdown.length, Math.max(0, Math.trunc(cursor)));
}

function leadingSeparation(markdown: string) {
  if (!markdown) return '';
  if (markdown.endsWith('\n\n')) return '';
  return markdown.endsWith('\n') ? '\n' : '\n\n';
}

function trailingSeparation(markdown: string) {
  if (!markdown) return '';
  if (markdown.startsWith('\n\n')) return '';
  return markdown.startsWith('\n') ? '\n' : '\n\n';
}

export function selectPastedIssueAttachmentImages({
  attachments,
  createAttachmentId,
  images
}: {
  attachments: readonly IssueAttachmentDraft[];
  createAttachmentId(): string;
  images: readonly Blob[];
}): IssueAttachmentPasteSelection {
  const accepted: SelectedIssueAttachmentImage[] = [];
  const errors: string[] = [];
  let count = attachments.length;
  let totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.sizeBytes,
    0
  );

  for (const image of images) {
    let candidate;
    try {
      candidate = validateIssueAttachmentCandidate({
        mediaType: image.type,
        sizeBytes: image.size
      });
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : 'This pasted image cannot be attached.'
      );
      continue;
    }

    if (count >= ISSUE_ATTACHMENT_DRAFT_MAX_COUNT) {
      errors.push('You can attach up to 10 images to one issue draft.');
      continue;
    }
    if (totalBytes + candidate.sizeBytes > ISSUE_ATTACHMENT_DRAFT_MAX_BYTES) {
      errors.push('Pasted images can use up to 50 MiB per issue draft.');
      continue;
    }

    accepted.push({ attachmentId: createAttachmentId(), image });
    count += 1;
    totalBytes += candidate.sizeBytes;
  }

  return {
    accepted,
    error: errors.length > 0 ? uniqueMessages(errors) : null
  };
}

export function prepareIssueAttachmentPasteLayout({
  attachmentIds,
  cursor,
  markdown
}: {
  attachmentIds: readonly string[];
  cursor: number;
  markdown: string;
}): IssueAttachmentPasteLayout {
  const insertionPoint = safeCursor(markdown, cursor);
  if (attachmentIds.length === 0) {
    return {
      insertionCursors: [],
      markdown,
      selectionEnd: insertionPoint
    };
  }

  const before = markdown.slice(0, insertionPoint);
  const after = markdown.slice(insertionPoint);
  const prefix = leadingSeparation(before);
  const suffix = trailingSeparation(after);
  const separators = '\n\n'.repeat(attachmentIds.length - 1);
  const insertionStart = before.length + prefix.length;
  const preparedMarkdown = `${before}${prefix}${separators}${suffix}${after}`;
  const insertionCursors: number[] = [];
  let nextCursor = insertionStart;

  for (const attachmentId of attachmentIds) {
    insertionCursors.push(nextCursor);
    nextCursor += issueAttachmentPlaceholder(attachmentId).length + 2;
  }

  return {
    insertionCursors,
    markdown: preparedMarkdown,
    selectionEnd: nextCursor - 2
  };
}

export function clipboardIssueAttachmentImages(dataTransfer: DataTransfer) {
  const itemImages = Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (itemImages.length > 0) return itemImages;
  return Array.from(dataTransfer.files).filter((file) => file.type.startsWith('image/'));
}
