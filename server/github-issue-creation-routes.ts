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
  bodyReadTimeoutMs?: number;
  loadMetadata?(fullName: string): Promise<LocalGitHubIssueMetadataResult>;
  maximumBodyBytes?: number;
  maximumConcurrentUploads?: number;
  maximumWaitingUploads?: number;
  uploadAttachment?(
    request: LocalGitHubIssueAttachmentRequest
  ): Promise<LocalGitHubIssueAttachmentResult>;
}

class IssueAttachmentBodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 408 | 413
  ) {
    super(message);
  }
}

class IssueAttachmentBusyError extends Error {}

const supportedMediaTypes = new Set(['image/gif', 'image/jpeg', 'image/png']);
const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const defaultBodyReadTimeoutMs = 15_000;

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
  maximumBytes = GITHUB_ISSUE_MAX_ATTACHMENT_BYTES,
  timeoutMs = defaultBodyReadTimeoutMs
) {
  const declaredLength = contentLength(request, maximumBytes);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readBody = async () => {
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
  };

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new IssueAttachmentBodyError('The issue image upload timed out.', 408));
      request.destroy();
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([readBody(), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createGitHubIssueCreationRoutes(
  options: GitHubIssueCreationRouteOptions = {}
) {
  const loadMetadata = options.loadMetadata ?? loadLocalGitHubIssueMetadata;
  const uploadAttachment = options.uploadAttachment ?? uploadLocalGitHubIssueAttachment;
  const bodyReadTimeoutMs =
    Number.isSafeInteger(options.bodyReadTimeoutMs) && (options.bodyReadTimeoutMs ?? 0) > 0
      ? options.bodyReadTimeoutMs!
      : defaultBodyReadTimeoutMs;
  const maximumBodyBytes =
    Number.isSafeInteger(options.maximumBodyBytes) && (options.maximumBodyBytes ?? 0) > 0
      ? options.maximumBodyBytes!
      : GITHUB_ISSUE_MAX_ATTACHMENT_BYTES;
  const maximumConcurrentUploads =
    Number.isSafeInteger(options.maximumConcurrentUploads)
      && (options.maximumConcurrentUploads ?? 0) > 0
      ? options.maximumConcurrentUploads!
      : 2;
  const maximumWaitingUploads =
    Number.isSafeInteger(options.maximumWaitingUploads)
      && (options.maximumWaitingUploads ?? -1) >= 0
      ? options.maximumWaitingUploads!
      : 16;
  let activeUploads = 0;
  const waitingUploads: Array<() => void> = [];

  async function acquireUploadSlot() {
    if (activeUploads < maximumConcurrentUploads) {
      activeUploads += 1;
      return;
    }
    if (waitingUploads.length >= maximumWaitingUploads) {
      throw new IssueAttachmentBusyError();
    }
    await new Promise<void>((resolve) => waitingUploads.push(resolve));
  }

  function releaseUploadSlot() {
    const next = waitingUploads.shift();
    if (next) next();
    else activeUploads -= 1;
  }

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
    const rawIssueNumber = url.searchParams.get('issueNumber');
    const issueNumber = rawIssueNumber && /^[1-9]\d*$/.test(rawIssueNumber)
      ? Number(rawIssueNumber)
      : 0;
    if (
      !fullName
      || !attachmentId
      || !hasExactSearchParams(
        url.searchParams,
        ['fullName', 'attachmentId', 'issueNumber']
      )
      || !isValidGitHubRepositoryFullName(fullName)
      || !attachmentIdPattern.test(attachmentId)
      || !Number.isSafeInteger(issueNumber)
      || issueNumber <= 0
    ) {
      writeJson(response, 400, { error: 'Invalid attachment repository or identifier.' });
      return true;
    }

    const rawMediaType = request.headers['content-type'];
    const declaredMediaType =
      typeof rawMediaType === 'string' ? rawMediaType.trim().toLowerCase() : '';
    if (!supportedMediaTypes.has(declaredMediaType)) {
      writeJson(response, 415, { error: 'Paste a PNG, JPEG, or non-animated GIF image.' });
      return true;
    }

    let hasUploadSlot = false;
    try {
      await acquireUploadSlot();
      hasUploadSlot = true;
      const bytes = await readGitHubIssueAttachmentBody(
        request,
        maximumBodyBytes,
        bodyReadTimeoutMs
      );
      writeJson(
        response,
        200,
        await uploadAttachment({
          attachmentId,
          bytes,
          declaredMediaType,
          fullName,
          issueNumber
        })
      );
    } catch (error) {
      if (error instanceof IssueAttachmentBodyError) {
        writeJson(response, error.statusCode, { error: error.message });
      } else if (error instanceof IssueAttachmentBusyError) {
        response.setHeader('Retry-After', '1');
        writeJson(response, 429, { error: 'Too many issue images are waiting to upload.' });
      } else {
        throw error;
      }
    } finally {
      if (hasUploadSlot) releaseUploadSlot();
    }
    return true;
  };
}
