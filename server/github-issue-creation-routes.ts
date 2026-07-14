import type { IncomingMessage, ServerResponse } from 'node:http';

import { GITHUB_ISSUE_MAX_ATTACHMENT_BYTES } from './github-issue-attachment-validation';
import {
  uploadLocalGitHubIssueAttachment,
  type LocalGitHubIssueAttachmentRequest,
  type LocalGitHubIssueAttachmentResult
} from './local-github-issue-attachments';
import {
  isValidGitHubRepositoryFullName,
  loadLocalGitHubIssueMetadata,
  type LocalGitHubIssueMetadataResult
} from './local-github-issue-metadata';
import { writeJson } from './project-space-http-response';

interface GitHubIssueCreationRouteOptions {
  loadMetadata?(fullName: string): Promise<LocalGitHubIssueMetadataResult>;
  maximumBodyBytes?: number;
  uploadAttachment?(
    request: LocalGitHubIssueAttachmentRequest
  ): Promise<LocalGitHubIssueAttachmentResult>;
}

class IssueAttachmentBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 413
  ) {
    super(message);
  }
}

const supportedMediaTypes = new Set(['image/gif', 'image/jpeg', 'image/png']);
const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hasExactSearchParams(searchParams: URLSearchParams, keys: readonly string[]) {
  const expected = new Set(keys);
  const entries = Array.from(searchParams.keys());
  return entries.length === expected.size && entries.every((key) => expected.has(key));
}

function contentLength(request: IncomingMessage, maximumBytes: number) {
  const header = request.headers['content-length'];
  if (header === undefined) return undefined;
  if (Array.isArray(header) || !/^(0|[1-9]\d*)$/.test(header)) {
    throw new IssueAttachmentBodyError('Invalid image content length.', 400);
  }

  const value = Number(header);
  if (!Number.isSafeInteger(value)) {
    throw new IssueAttachmentBodyError('Invalid image content length.', 400);
  }
  if (value > maximumBytes) {
    throw new IssueAttachmentBodyError('The issue image is larger than 10 MiB.', 413);
  }
  return value;
}

export async function readGitHubIssueAttachmentBody(
  request: IncomingMessage,
  maximumBytes = GITHUB_ISSUE_MAX_ATTACHMENT_BYTES
) {
  const declaredLength = contentLength(request, maximumBytes);
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) {
      throw new IssueAttachmentBodyError('The issue image is larger than 10 MiB.', 413);
    }
    chunks.push(buffer);
  }

  if (declaredLength !== undefined && declaredLength !== size) {
    throw new IssueAttachmentBodyError('The issue image body is incomplete.', 400);
  }
  if (size === 0) {
    throw new IssueAttachmentBodyError('The issue image is empty.', 400);
  }
  return Buffer.concat(chunks, size);
}

export function createGitHubIssueCreationRoutes(
  options: GitHubIssueCreationRouteOptions = {}
) {
  const loadMetadata = options.loadMetadata ?? loadLocalGitHubIssueMetadata;
  const uploadAttachment = options.uploadAttachment ?? uploadLocalGitHubIssueAttachment;
  const maximumBodyBytes =
    Number.isSafeInteger(options.maximumBodyBytes) && (options.maximumBodyBytes ?? 0) > 0
      ? options.maximumBodyBytes!
      : GITHUB_ISSUE_MAX_ATTACHMENT_BYTES;

  return async function handleGitHubIssueCreationRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ) {
    if (request.method === 'GET' && url.pathname === '/api/github/issue-metadata') {
      const fullName = url.searchParams.get('fullName');
      if (!fullName || !hasExactSearchParams(url.searchParams, ['fullName'])) {
        writeJson(response, 400, { error: 'Invalid repository metadata request.' });
        return true;
      }

      response.setHeader('Cache-Control', 'private, no-store');
      writeJson(response, 200, await loadMetadata(fullName));
      return true;
    }

    if (request.method !== 'POST' || url.pathname !== '/api/github/issue-attachments') {
      return false;
    }

    response.setHeader('Cache-Control', 'private, no-store');
    const fullName = url.searchParams.get('fullName');
    const attachmentId = url.searchParams.get('attachmentId');
    if (
      !fullName
      || !attachmentId
      || !hasExactSearchParams(url.searchParams, ['fullName', 'attachmentId'])
      || !isValidGitHubRepositoryFullName(fullName)
      || !attachmentIdPattern.test(attachmentId)
    ) {
      writeJson(response, 400, { error: 'Invalid attachment repository or identifier.' });
      return true;
    }

    const rawMediaType = request.headers['content-type'];
    const declaredMediaType =
      typeof rawMediaType === 'string' ? rawMediaType.trim().toLowerCase() : '';
    if (!supportedMediaTypes.has(declaredMediaType)) {
      writeJson(response, 415, { error: 'Paste a PNG, JPEG, or GIF image.' });
      return true;
    }

    try {
      const bytes = await readGitHubIssueAttachmentBody(request, maximumBodyBytes);
      writeJson(
        response,
        200,
        await uploadAttachment({ attachmentId, bytes, declaredMediaType, fullName })
      );
    } catch (error) {
      if (error instanceof IssueAttachmentBodyError) {
        writeJson(response, error.statusCode, { error: error.message });
      } else {
        throw error;
      }
    }
    return true;
  };
}
