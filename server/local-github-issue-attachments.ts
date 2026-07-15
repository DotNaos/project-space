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
  issueNumber: number;
}

export type LocalGitHubIssueAttachmentResult = {
  attachmentId: string;
  fullName: string;
  issueNumber: number;
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

interface GitHubRepositoryResponse {
  archived?: unknown;
  default_branch?: unknown;
  disabled?: unknown;
  permissions?: { push?: unknown };
}

interface GitHubIssueResponse {
  number?: unknown;
  pull_request?: unknown;
}

interface GitHubRefResponse {
  object?: { sha?: unknown };
  ref?: unknown;
}

interface IssueAttachmentStorageTarget {
  branchName: string;
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
  'GitHub could not store this issue image on its dedicated attachment branch. Check repository write access and branch rules, then retry.';
const storagePermissionMessage =
  'Issue images require repository write access. Remove the image to continue without it, or ask a maintainer for access.';

function resultBase(request: LocalGitHubIssueAttachmentRequest) {
  return {
    attachmentId: request.attachmentId,
    fullName: request.fullName,
    issueNumber: request.issueNumber
  };
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

function hasInvalidRefCharacter(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20
      || code === 0x7f
      || '~^:?*[\\'.includes(character);
  });
}

function issueAttachmentPath(
  issueNumber: number,
  attachmentId: string,
  extension: string
) {
  return (
    `.github/project-space/issue-attachments/${issueNumber}/`
    + `${attachmentId}.${extension}`
  );
}

function issueAttachmentBranch(issueNumber: number) {
  return `project-space-issue-${issueNumber}-attachments`;
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

function isGitHubStatus(error: unknown, status: number) {
  return error instanceof Error && error.message === `GitHub request failed with ${status}.`;
}

function refCommitSha(value: GitHubRefResponse, expectedRef: string) {
  const sha = typeof value.object?.sha === 'string'
    ? value.object.sha.toLowerCase()
    : '';
  return value.ref === expectedRef && gitShaPattern.test(sha) ? sha : null;
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
  branchName: string,
  token: string,
  dependencies: LocalGitHubIssueAttachmentDependencies
) {
  const repoPath = repositoryApiPath(request.fullName);
  const expectedRef = `refs/heads/${branchName}`;
  const branch = await dependencies.requestGitHub<GitHubRefResponse>(
    `/repos/${repoPath}/git/ref/heads/${contentApiPath(branchName)}`,
    token
  );
  const commitSha = refCommitSha(branch, expectedRef);
  if (!commitSha) {
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

async function ensureIssueAttachmentBranch(
  request: LocalGitHubIssueAttachmentRequest,
  token: string,
  dependencies: LocalGitHubIssueAttachmentDependencies
) {
  const repoPath = repositoryApiPath(request.fullName);
  const [repository, issue] = await Promise.all([
    dependencies.requestGitHub<GitHubRepositoryResponse>(
      `/repos/${repoPath}`,
      token
    ),
    dependencies.requestGitHub<GitHubIssueResponse>(
      `/repos/${repoPath}/issues/${request.issueNumber}`,
      token
    )
  ]);
  if (
    issue.number !== request.issueNumber
    || issue.pull_request !== undefined
  ) {
    return issueAttachmentError(request, 'The issue image target is invalid.');
  }
  if (
    repository.archived === true
    || repository.disabled === true
    || repository.permissions?.push === false
  ) {
    return issueAttachmentError(request, storagePermissionMessage);
  }

  const defaultBranch = typeof repository.default_branch === 'string'
    ? repository.default_branch
    : '';
  if (
    !defaultBranch
    || defaultBranch.length > 255
    || hasInvalidRefCharacter(defaultBranch)
    || defaultBranch.includes('..')
    || defaultBranch.includes('@{')
  ) {
    return issueAttachmentError(request, storageFailureMessage);
  }

  const branchName = issueAttachmentBranch(request.issueNumber);
  const expectedRef = `refs/heads/${branchName}`;
  const branchApiPath =
    `/repos/${repoPath}/git/ref/heads/${contentApiPath(branchName)}`;
  try {
    const existing = await dependencies.requestGitHub<GitHubRefResponse>(
      branchApiPath,
      token
    );
    const existingSha = refCommitSha(existing, expectedRef);
    return existingSha
      ? { branchName }
      : issueAttachmentError(request, storageFailureMessage);
  } catch (error) {
    if (!isGitHubStatus(error, 404)) throw error;
  }

  const defaultRefName = `refs/heads/${defaultBranch}`;
  const defaultRef = await dependencies.requestGitHub<GitHubRefResponse>(
    `/repos/${repoPath}/git/ref/heads/${contentApiPath(defaultBranch)}`,
    token
  );
  const defaultSha = refCommitSha(defaultRef, defaultRefName);
  if (!defaultSha) return issueAttachmentError(request, storageFailureMessage);

  try {
    const created = await dependencies.requestGitHub<GitHubRefResponse>(
      `/repos/${repoPath}/git/refs`,
      token,
      {
        body: JSON.stringify({ ref: expectedRef, sha: defaultSha }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: AbortSignal.timeout(30_000)
      }
    );
    return refCommitSha(created, expectedRef)
      ? { branchName }
      : issueAttachmentError(request, storageFailureMessage);
  } catch (error) {
    if (!isContentConflict(error)) throw error;
    const existing = await dependencies.requestGitHub<GitHubRefResponse>(
      branchApiPath,
      token
    );
    const existingSha = refCommitSha(existing, expectedRef);
    return existingSha
      ? { branchName }
      : issueAttachmentError(request, storageFailureMessage);
  }
}

export async function uploadLocalGitHubIssueAttachment(
  request: LocalGitHubIssueAttachmentRequest,
  dependencies: LocalGitHubIssueAttachmentDependencies = defaultDependencies
): Promise<LocalGitHubIssueAttachmentResult> {
  if (
    !isValidGitHubRepositoryFullName(request.fullName) ||
    !attachmentIdPattern.test(request.attachmentId) ||
    !Number.isSafeInteger(request.issueNumber) ||
    request.issueNumber <= 0
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
      'Paste a valid PNG, JPEG, or non-animated GIF image up to 10 MiB.'
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

  const path = issueAttachmentPath(
    request.issueNumber,
    request.attachmentId,
    validated.extension
  );
  const expectedBlobSha = gitBlobSha(request.bytes);
  const apiPath =
    `/repos/${repositoryApiPath(request.fullName)}/contents/${contentApiPath(path)}`;
  let storageTarget: IssueAttachmentStorageTarget | null = null;
  let invalidWriteResponse = false;

  try {
    const resolvedStorageTarget = await ensureIssueAttachmentBranch(
      request,
      auth.token,
      dependencies
    );
    if ('status' in resolvedStorageTarget) return resolvedStorageTarget;
    storageTarget = resolvedStorageTarget;

    const response = await dependencies.requestGitHub<GitHubContentsWriteResponse>(
      apiPath,
      auth.token,
      {
        body: JSON.stringify({
          branch: storageTarget.branchName,
          content: Buffer.from(request.bytes).toString('base64'),
          message: `Add image for issue #${request.issueNumber}`
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
      invalidWriteResponse = true;
      throw new Error('GitHub returned invalid issue image data.');
    }

    return connectedResult(
      request,
      validated,
      immutableMarkdownUrl(request.fullName, commitSha, path)
    );
  } catch (error) {
    if (storageTarget) {
      try {
        const recovered = await recoverExistingAttachment(
          request,
          validated,
          path,
          expectedBlobSha,
          storageTarget.branchName,
          auth.token,
          dependencies
        );
        if (recovered.status === 'connected') return recovered;
      } catch {
        // Recovery is best-effort after an ambiguous or rejected write.
      }
    }

    return issueAttachmentError(
      request,
      invalidWriteResponse ? 'GitHub returned invalid issue image data.' : storageFailureMessage
    );
  }
}
