import { createHash } from 'node:crypto';

import {
  getGitHubClientId,
  githubOAuthClientIdMissingMessage,
  requestGitHub,
  resolveOAuthToken
} from './local-github-catalog';
import {
  validateGitHubIssueAttachment,
  type GitHubIssueAttachmentMediaType,
  type ValidatedGitHubIssueAttachment
} from './github-issue-attachment-validation';
import { isValidGitHubRepositoryFullName } from './local-github-issue-metadata';

export interface LocalGitHubIssueAttachmentRequest {
  attachmentId: string;
  bytes: Uint8Array;
  declaredMediaType: string;
  fullName: string;
}

export type LocalGitHubIssueAttachmentResult = {
  attachmentId: string;
  fullName: string;
  message?: string;
  status: 'connected' | 'auth-required' | 'not-configured' | 'error';
} & Partial<{
  markdownUrl: string;
  mediaType: GitHubIssueAttachmentMediaType;
  sizeBytes: number;
}>;

export interface LocalGitHubIssueAttachmentDependencies {
  getGitHubClientId(): string;
  requestGitHub<T>(path: string, token: string, init?: RequestInit): Promise<T>;
  resolveOAuthToken(): Promise<{ token: string } | null>;
  validateAttachment(input: {
    bytes: Uint8Array;
    declaredMediaType: string;
  }): Promise<ValidatedGitHubIssueAttachment>;
}

interface GitHubContentsWriteResponse {
  commit?: { sha?: unknown };
  content?: { path?: unknown; sha?: unknown };
}

interface GitHubContentsReadResponse {
  path?: unknown;
  sha?: unknown;
}

interface GitHubCommitResponse {
  sha?: unknown;
}

const defaultDependencies: LocalGitHubIssueAttachmentDependencies = {
  getGitHubClientId,
  requestGitHub,
  resolveOAuthToken,
  validateAttachment: validateGitHubIssueAttachment
};
const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const storageFailureMessage =
  'GitHub could not store this issue image. Check repository write access and branch rules, then retry.';

function resultBase(request: LocalGitHubIssueAttachmentRequest) {
  return { attachmentId: request.attachmentId, fullName: request.fullName };
}

function issueAttachmentError(
  request: LocalGitHubIssueAttachmentRequest,
  message: string
): LocalGitHubIssueAttachmentResult {
  return { ...resultBase(request), message, status: 'error' };
}

function repositoryApiPath(fullName: string) {
  return fullName.split('/').map(encodeURIComponent).join('/');
}

function contentApiPath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function issueAttachmentPath(attachmentId: string, extension: string) {
  return `.github/project-space/issue-attachments/${attachmentId}.${extension}`;
}

function gitBlobSha(bytes: Uint8Array) {
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest('hex');
}

function immutableMarkdownUrl(fullName: string, commitSha: string, path: string) {
  const encodedPath = contentApiPath(path);
  return `https://github.com/${repositoryApiPath(fullName)}/blob/${commitSha}/${encodedPath}?raw=1`;
}

function isContentConflict(error: unknown) {
  return (
    error instanceof Error &&
    (error.message === 'GitHub request failed with 409.' ||
      error.message === 'GitHub request failed with 422.')
  );
}

function connectedResult(
  request: LocalGitHubIssueAttachmentRequest,
  validated: ValidatedGitHubIssueAttachment,
  markdownUrl: string
): LocalGitHubIssueAttachmentResult {
  return {
    ...resultBase(request),
    markdownUrl,
    mediaType: validated.mediaType,
    sizeBytes: request.bytes.byteLength,
    status: 'connected'
  };
}

async function recoverExistingAttachment(
  request: LocalGitHubIssueAttachmentRequest,
  validated: ValidatedGitHubIssueAttachment,
  expectedPath: string,
  expectedBlobSha: string,
  token: string,
  dependencies: LocalGitHubIssueAttachmentDependencies
) {
  const repoPath = repositoryApiPath(request.fullName);
  const commits = await dependencies.requestGitHub<unknown>(
    `/repos/${repoPath}/commits?path=${encodeURIComponent(expectedPath)}&per_page=1`,
    token
  );
  const commitSha =
    Array.isArray(commits) && commits.length === 1
      ? (commits[0] as GitHubCommitResponse | undefined)?.sha
      : undefined;
  if (typeof commitSha !== 'string' || !gitShaPattern.test(commitSha)) {
    return issueAttachmentError(request, storageFailureMessage);
  }

  const existing = await dependencies.requestGitHub<GitHubContentsReadResponse>(
    `/repos/${repoPath}/contents/${contentApiPath(expectedPath)}?ref=${commitSha}`,
    token
  );

  return existing.path === expectedPath &&
    existing.sha === expectedBlobSha
    ? connectedResult(
        request,
        validated,
        immutableMarkdownUrl(request.fullName, commitSha, expectedPath)
      )
    : issueAttachmentError(request, storageFailureMessage);
}

export async function uploadLocalGitHubIssueAttachment(
  request: LocalGitHubIssueAttachmentRequest,
  dependencies: LocalGitHubIssueAttachmentDependencies = defaultDependencies
): Promise<LocalGitHubIssueAttachmentResult> {
  if (
    !isValidGitHubRepositoryFullName(request.fullName) ||
    !attachmentIdPattern.test(request.attachmentId)
  ) {
    return issueAttachmentError(request, 'The issue image request is invalid.');
  }

  let validated: ValidatedGitHubIssueAttachment;
  try {
    validated = await dependencies.validateAttachment({
      bytes: request.bytes,
      declaredMediaType: request.declaredMediaType
    });
  } catch {
    return issueAttachmentError(
      request,
      'Paste a valid PNG, JPEG, or GIF image up to 10 MiB.'
    );
  }

  const auth = await dependencies.resolveOAuthToken();
  if (!auth) {
    const configured = Boolean(dependencies.getGitHubClientId());
    return {
      ...resultBase(request),
      message: configured
        ? 'Connect GitHub to store issue images.'
        : githubOAuthClientIdMissingMessage,
      status: configured ? 'auth-required' : 'not-configured'
    };
  }

  const path = issueAttachmentPath(request.attachmentId, validated.extension);
  const expectedBlobSha = gitBlobSha(request.bytes);
  const apiPath =
    `/repos/${repositoryApiPath(request.fullName)}/contents/${contentApiPath(path)}`;

  try {
    const response = await dependencies.requestGitHub<GitHubContentsWriteResponse>(
      apiPath,
      auth.token,
      {
        body: JSON.stringify({
          content: Buffer.from(request.bytes).toString('base64'),
          message: 'Add Project Space issue image'
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
        signal: AbortSignal.timeout(30_000)
      }
    );
    const commitSha =
      typeof response.commit?.sha === 'string'
        ? response.commit.sha.toLowerCase()
        : '';

    if (
      !gitShaPattern.test(commitSha) ||
      response.content?.path !== path ||
      response.content?.sha !== expectedBlobSha
    ) {
      return issueAttachmentError(request, 'GitHub returned invalid issue image data.');
    }

    return connectedResult(
      request,
      validated,
      immutableMarkdownUrl(request.fullName, commitSha, path)
    );
  } catch (error) {
    if (isContentConflict(error)) {
      try {
        return await recoverExistingAttachment(
          request,
          validated,
          path,
          expectedBlobSha,
          auth.token,
          dependencies
        );
      } catch {
        // Use the same non-sensitive failure as an ordinary write rejection.
      }
    }

    return issueAttachmentError(request, storageFailureMessage);
  }
}
