import {
  getGitHubClientId,
  githubOAuthClientIdMissingMessage,
  resolveOAuthToken
} from './local-github-catalog';
import {
  GITHUB_ISSUE_MAX_ATTACHMENT_BYTES,
  validateGitHubIssueAttachment,
  type GitHubIssueAttachmentMediaType,
  type ValidatedGitHubIssueAttachment
} from './github-issue-attachment-validation';
import {
  gitHubIssueAttachmentMediaType,
  gitHubIssueAttachmentRepositoryPath,
  isGitHubIssueAttachmentLocation,
  type GitHubIssueAttachmentLocation
} from '../src/shared/github-issue-attachment-location';

export type LocalGitHubIssueAttachmentContentResult =
  | {
      bytes: Uint8Array;
      mediaType: GitHubIssueAttachmentMediaType;
      sizeBytes: number;
      status: 'connected';
    }
  | {
      message: string;
      status: 'auth-required' | 'not-configured' | 'error';
    };

export interface LocalGitHubIssueAttachmentContentDependencies {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  getGitHubClientId(): string;
  maximumBytes?: number;
  resolveOAuthToken(): Promise<{ token: string } | null>;
  validateAttachment(input: {
    bytes: Uint8Array;
    declaredMediaType: string;
  }): Promise<ValidatedGitHubIssueAttachment>;
}

const defaultDependencies: LocalGitHubIssueAttachmentContentDependencies = {
  fetch,
  getGitHubClientId,
  resolveOAuthToken,
  validateAttachment: validateGitHubIssueAttachment
};
const githubApiBaseUrl = 'https://api.github.com';
const maximumConcurrentContentLoads = 2;
const maximumWaitingContentLoads = 16;
let activeContentLoads = 0;
const waitingContentLoads: Array<() => void> = [];

async function acquireContentLoadSlot() {
  if (activeContentLoads < maximumConcurrentContentLoads) {
    activeContentLoads += 1;
    return;
  }
  if (waitingContentLoads.length >= maximumWaitingContentLoads) {
    throw new Error('Too many issue images are waiting to load.');
  }
  await new Promise<void>((resolve) => waitingContentLoads.push(resolve));
}

function releaseContentLoadSlot() {
  const next = waitingContentLoads.shift();
  if (next) next();
  else activeContentLoads -= 1;
}

async function withContentLoadSlot<T>(operation: () => Promise<T>) {
  await acquireContentLoadSlot();
  try {
    return await operation();
  } finally {
    releaseContentLoadSlot();
  }
}

function encodedPath(value: string) {
  return value.split('/').map(encodeURIComponent).join('/');
}

function githubContentUrl(location: GitHubIssueAttachmentLocation) {
  const path = gitHubIssueAttachmentRepositoryPath(location);
  const url = new URL(
    `/repos/${encodedPath(location.fullName)}/contents/${encodedPath(path)}`,
    githubApiBaseUrl
  );
  url.searchParams.set('ref', location.commitSha);
  return url;
}

function maximumBytes(dependencies: LocalGitHubIssueAttachmentContentDependencies) {
  const configured = dependencies.maximumBytes;
  return Number.isSafeInteger(configured) && (configured ?? 0) > 0
    ? configured!
    : GITHUB_ISSUE_MAX_ATTACHMENT_BYTES;
}

async function readBoundedResponse(response: Response, limit: number) {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && (!/^(0|[1-9]\d*)$/.test(declaredLength) || Number(declaredLength) > limit)
  ) {
    throw new Error('Invalid GitHub image length.');
  }
  if (!response.body) throw new Error('Missing GitHub image body.');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('GitHub image body is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size === 0) throw new Error('GitHub image body is empty.');
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
}

function issueAttachmentContentError(): LocalGitHubIssueAttachmentContentResult {
  return {
    message: 'GitHub could not load this issue image.',
    status: 'error'
  };
}

export async function loadLocalGitHubIssueAttachmentContent(
  location: GitHubIssueAttachmentLocation,
  dependencies: LocalGitHubIssueAttachmentContentDependencies = defaultDependencies
): Promise<LocalGitHubIssueAttachmentContentResult> {
  if (!isGitHubIssueAttachmentLocation(location)) {
    return issueAttachmentContentError();
  }

  const auth = await dependencies.resolveOAuthToken();
  if (!auth) {
    const configured = Boolean(dependencies.getGitHubClientId());
    return {
      message: configured
        ? 'Connect GitHub to load this issue image.'
        : githubOAuthClientIdMissingMessage,
      status: configured ? 'auth-required' : 'not-configured'
    };
  }

  const expectedMediaType = gitHubIssueAttachmentMediaType(location.extension);
  try {
    return await withContentLoadSlot(async () => {
      const response = await dependencies.fetch(githubContentUrl(location), {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github.raw+json',
          Authorization: `Bearer ${auth.token}`,
          'X-GitHub-Api-Version': '2022-11-28'
        },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) return issueAttachmentContentError();

      const bytes = await readBoundedResponse(response, maximumBytes(dependencies));
      const validated = await dependencies.validateAttachment({
        bytes,
        declaredMediaType: expectedMediaType
      });
      if (
        validated.extension !== location.extension
        || validated.mediaType !== expectedMediaType
      ) {
        return issueAttachmentContentError();
      }

      return {
        bytes,
        mediaType: validated.mediaType,
        sizeBytes: bytes.byteLength,
        status: 'connected' as const
      };
    });
  } catch {
    return issueAttachmentContentError();
  }
}
