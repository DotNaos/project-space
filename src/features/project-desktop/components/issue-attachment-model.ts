import {
  gitHubIssueAttachmentMediaType,
  parseProjectSpaceGitHubIssueAttachmentUrl
} from '../../../shared/github-issue-attachment-location';

export const GITHUB_ISSUE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export type IssueAttachmentMediaType = 'image/gif' | 'image/jpeg' | 'image/png';

export type IssueAttachmentValidationErrorCode =
  | 'empty-image'
  | 'image-too-large'
  | 'invalid-size'
  | 'unsupported-image-type';

export class IssueAttachmentValidationError extends Error {
  readonly code: IssueAttachmentValidationErrorCode;

  constructor(code: IssueAttachmentValidationErrorCode, message: string) {
    super(message);
    this.name = 'IssueAttachmentValidationError';
    this.code = code;
  }
}

export interface IssueAttachmentCandidate {
  mediaType: string;
  sizeBytes: number;
}

export interface ValidIssueAttachmentCandidate {
  mediaType: IssueAttachmentMediaType;
  sizeBytes: number;
}

interface IssueAttachmentBase {
  attachmentId: string;
  mediaType: IssueAttachmentMediaType;
  repositoryKey: string;
  sizeBytes: number;
}

export type IssueAttachmentDraft =
  | (IssueAttachmentBase & {
      requestId: null;
      status: 'queued';
    })
  | (IssueAttachmentBase & {
      requestId: string;
      status: 'uploading';
    })
  | (IssueAttachmentBase & {
      error: string;
      requestId: string;
      status: 'failed';
    })
  | (IssueAttachmentBase & {
      markdownUrl: string;
      renderedMarkdown: string;
      requestId: string;
      status: 'uploaded';
    });

export interface IssueAttachmentState {
  attachments: readonly IssueAttachmentDraft[];
  markdown: string;
  repositoryKey: string | null;
}

export type IssueAttachmentAction =
  | { markdown: string; type: 'markdown-changed' }
  | { repositoryKey: string | null; type: 'repository-changed' }
  | {
      attachmentId: string;
      cursor: number;
      mediaType: string;
      originalName?: string;
      repositoryKey: string;
      sizeBytes: number;
      type: 'attachment-queued';
    }
  | {
      attachmentId: string;
      repositoryKey: string;
      requestId: string;
      type: 'upload-started';
    }
  | {
      attachmentId: string;
      error: string;
      repositoryKey: string;
      requestId: string;
      type: 'upload-failed';
    }
  | {
      attachmentId: string;
      markdownUrl: string;
      repositoryKey: string;
      requestId: string;
      type: 'upload-succeeded';
    }
  | { attachmentId: string; type: 'attachment-removed' };

const SUPPORTED_MEDIA_TYPES = new Set<IssueAttachmentMediaType>([
  'image/gif',
  'image/jpeg',
  'image/png'
]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_MARKDOWN_HTTPS_URL = /^https:\/\/[^\s<>()]+$/;
const GITHUB_IMAGE_HOSTS = new Set([
  'github.com',
  'private-user-images.githubusercontent.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com'
]);

export function validateIssueAttachmentCandidate({
  mediaType,
  sizeBytes
}: IssueAttachmentCandidate): ValidIssueAttachmentCandidate {
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType as IssueAttachmentMediaType)) {
    throw new IssueAttachmentValidationError(
      'unsupported-image-type',
      'Paste a PNG, JPEG, or non-animated GIF image.'
    );
  }

  if (!Number.isSafeInteger(sizeBytes)) {
    throw new IssueAttachmentValidationError(
      'invalid-size',
      'The pasted image size is invalid.'
    );
  }

  if (sizeBytes <= 0) {
    throw new IssueAttachmentValidationError('empty-image', 'The pasted image is empty.');
  }

  if (sizeBytes > GITHUB_ISSUE_ATTACHMENT_MAX_BYTES) {
    throw new IssueAttachmentValidationError(
      'image-too-large',
      'Pasted images must be 10 MiB or smaller.'
    );
  }

  return { mediaType: mediaType as IssueAttachmentMediaType, sizeBytes };
}

function normalizedRepositoryKey(repositoryKey: string | null) {
  const value = repositoryKey?.trim();
  return value || null;
}

function isSafeIdentifier(value: string) {
  return SAFE_IDENTIFIER.test(value);
}

export function issueAttachmentPlaceholder(attachmentId: string) {
  if (!isSafeIdentifier(attachmentId)) {
    throw new Error('The attachment identifier is invalid.');
  }

  return `![Pasted image uploading](project-space-attachment://${attachmentId})`;
}

function validMarkdownUrl(markdownUrl: string) {
  if (!SAFE_MARKDOWN_HTTPS_URL.test(markdownUrl)) {
    return false;
  }

  try {
    const parsed = new URL(markdownUrl);
    return (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      GITHUB_IMAGE_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function issueAttachmentMarkdown(markdownUrl: string) {
  if (!validMarkdownUrl(markdownUrl)) {
    throw new Error('The uploaded image URL is invalid.');
  }

  return `![Pasted image](${markdownUrl})`;
}

export function createInitialIssueAttachmentState({
  markdown = '',
  repositoryKey = null
}: {
  markdown?: string;
  repositoryKey?: string | null;
} = {}): IssueAttachmentState {
  return {
    attachments: [],
    markdown,
    repositoryKey: normalizedRepositoryKey(repositoryKey)
  };
}

function insertAtCursor(markdown: string, insertion: string, cursor: number) {
  const safeCursor = Number.isFinite(cursor)
    ? Math.min(markdown.length, Math.max(0, Math.trunc(cursor)))
    : markdown.length;

  return `${markdown.slice(0, safeCursor)}${insertion}${markdown.slice(safeCursor)}`;
}

function removeExactPlaceholder(markdown: string, attachmentId: string) {
  return removeAllAttachmentMarkdown(
    markdown,
    `project-space-attachment://${attachmentId}`
  );
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attachmentMarkdownPattern(url: string) {
  return new RegExp(
    `!\\[[^\\]\\r\\n]*\\]\\(${escapeRegularExpression(url)}\\)`,
    'g'
  );
}

function hasAttachmentMarkdown(markdown: string, url: string) {
  return attachmentMarkdownPattern(url).test(markdown);
}

function removeAllAttachmentMarkdown(markdown: string, url: string) {
  return markdown.replace(attachmentMarkdownPattern(url), '');
}

function removeAttachmentMarkdown(
  markdown: string,
  attachment: IssueAttachmentDraft
) {
  return attachment.status === 'uploaded'
    ? removeAllAttachmentMarkdown(markdown, attachment.markdownUrl)
    : removeExactPlaceholder(markdown, attachment.attachmentId);
}

function replaceExactPlaceholder(
  markdown: string,
  attachmentId: string,
  replacement: string
) {
  return markdown.replace(
    attachmentMarkdownPattern(`project-space-attachment://${attachmentId}`),
    replacement
  );
}

function attachmentIndex(
  state: IssueAttachmentState,
  repositoryKey: string,
  attachmentId: string
) {
  if (state.repositoryKey !== repositoryKey) {
    return -1;
  }

  return state.attachments.findIndex(
    (attachment) =>
      attachment.repositoryKey === repositoryKey && attachment.attachmentId === attachmentId
  );
}

function replaceAttachment(
  state: IssueAttachmentState,
  index: number,
  attachment: IssueAttachmentDraft,
  markdown = state.markdown
) {
  const attachments = state.attachments.slice();
  attachments[index] = attachment;
  return { ...state, attachments, markdown };
}

export function hasUnresolvedIssueAttachments(state: IssueAttachmentState) {
  return state.attachments.some(
    (attachment) =>
      attachment.repositoryKey === state.repositoryKey && attachment.status !== 'uploaded'
  );
}

export function issueAttachmentMarkdownWithoutAttachments(
  state: IssueAttachmentState
) {
  return state.attachments.reduce(
    (markdown, attachment) => removeAttachmentMarkdown(markdown, attachment),
    state.markdown
  );
}

export function issueAttachmentMarkdownWithUploadedAttachments(
  state: IssueAttachmentState
) {
  return state.attachments
    .filter((attachment) => attachment.status !== 'uploaded')
    .reduce(
      (markdown, attachment) => removeAttachmentMarkdown(markdown, attachment),
      state.markdown
    );
}

export function issueAttachmentReducer(
  state: IssueAttachmentState,
  action: IssueAttachmentAction
): IssueAttachmentState {
  switch (action.type) {
    case 'markdown-changed': {
      if (action.markdown === state.markdown) {
        return state;
      }
      const attachments = state.attachments.filter((attachment) =>
        hasAttachmentMarkdown(
          action.markdown,
          attachment.status === 'uploaded'
            ? attachment.markdownUrl
            : `project-space-attachment://${attachment.attachmentId}`
        )
      );
      return { ...state, attachments, markdown: action.markdown };
    }

    case 'repository-changed': {
      const repositoryKey = normalizedRepositoryKey(action.repositoryKey);
      if (repositoryKey === state.repositoryKey) {
        return state;
      }

      const markdown = state.attachments.reduce(
        (currentMarkdown, attachment) =>
          removeAttachmentMarkdown(currentMarkdown, attachment),
        state.markdown
      );
      return { attachments: [], markdown, repositoryKey };
    }

    case 'attachment-queued': {
      if (
        !state.repositoryKey ||
        state.repositoryKey !== action.repositoryKey ||
        !isSafeIdentifier(action.attachmentId) ||
        state.attachments.some(
          (attachment) => attachment.attachmentId === action.attachmentId
        )
      ) {
        return state;
      }

      let candidate: ValidIssueAttachmentCandidate;
      try {
        candidate = validateIssueAttachmentCandidate(action);
      } catch {
        return state;
      }

      const attachment: IssueAttachmentDraft = {
        attachmentId: action.attachmentId,
        mediaType: candidate.mediaType,
        repositoryKey: action.repositoryKey,
        requestId: null,
        sizeBytes: candidate.sizeBytes,
        status: 'queued'
      };
      return {
        ...state,
        attachments: [...state.attachments, attachment],
        markdown: insertAtCursor(
          state.markdown,
          issueAttachmentPlaceholder(action.attachmentId),
          action.cursor
        )
      };
    }

    case 'upload-started': {
      if (!isSafeIdentifier(action.requestId)) {
        return state;
      }

      const index = attachmentIndex(
        state,
        action.repositoryKey,
        action.attachmentId
      );
      const attachment = state.attachments[index];
      if (!attachment || attachment.status === 'uploaded') {
        return state;
      }

      return replaceAttachment(state, index, {
        attachmentId: attachment.attachmentId,
        mediaType: attachment.mediaType,
        repositoryKey: attachment.repositoryKey,
        requestId: action.requestId,
        sizeBytes: attachment.sizeBytes,
        status: 'uploading'
      });
    }

    case 'upload-failed': {
      const index = attachmentIndex(
        state,
        action.repositoryKey,
        action.attachmentId
      );
      const attachment = state.attachments[index];
      if (
        !attachment ||
        attachment.status !== 'uploading' ||
        attachment.requestId !== action.requestId
      ) {
        return state;
      }

      return replaceAttachment(state, index, {
        attachmentId: attachment.attachmentId,
        error: action.error,
        mediaType: attachment.mediaType,
        repositoryKey: attachment.repositoryKey,
        requestId: action.requestId,
        sizeBytes: attachment.sizeBytes,
        status: 'failed'
      });
    }

    case 'upload-succeeded': {
      const index = attachmentIndex(
        state,
        action.repositoryKey,
        action.attachmentId
      );
      const attachment = state.attachments[index];
      const location = parseProjectSpaceGitHubIssueAttachmentUrl(
        action.markdownUrl,
        action.repositoryKey
      );
      if (
        !attachment ||
        attachment.status !== 'uploading' ||
        attachment.requestId !== action.requestId ||
        !validMarkdownUrl(action.markdownUrl) ||
        !location ||
        location.attachmentId !== attachment.attachmentId ||
        gitHubIssueAttachmentMediaType(location.extension) !== attachment.mediaType
      ) {
        return state;
      }

      const replacement = issueAttachmentMarkdown(action.markdownUrl);
      return replaceAttachment(
        state,
        index,
        {
          attachmentId: attachment.attachmentId,
          markdownUrl: action.markdownUrl,
          mediaType: attachment.mediaType,
          renderedMarkdown: replacement,
          repositoryKey: attachment.repositoryKey,
          requestId: action.requestId,
          sizeBytes: attachment.sizeBytes,
          status: 'uploaded'
        },
        replaceExactPlaceholder(
          state.markdown,
          attachment.attachmentId,
          replacement
        )
      );
    }

    case 'attachment-removed': {
      const index = state.attachments.findIndex(
        (attachment) => attachment.attachmentId === action.attachmentId
      );
      const attachment = state.attachments[index];
      if (!attachment) {
        return state;
      }

      return {
        ...state,
        attachments: state.attachments.filter((_, itemIndex) => itemIndex !== index),
        markdown: removeAttachmentMarkdown(state.markdown, attachment)
      };
    }
  }
}
