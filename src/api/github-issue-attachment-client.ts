import {
  isProjectSpaceApiRequestAllowed,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from './project-space-client';
import {
  gitHubIssueAttachmentMediaType,
  parseProjectSpaceGitHubIssueAttachmentUrl
} from '../shared/github-issue-attachment-location';

export type GitHubIssueAttachmentMediaType = 'image/gif' | 'image/jpeg' | 'image/png';

export interface GitHubIssueAttachmentResult {
  attachmentId: string;
  fullName: string;
  markdownUrl?: string;
  mediaType?: GitHubIssueAttachmentMediaType;
  message?: string;
  sizeBytes?: number;
  status: 'connected' | 'auth-required' | 'not-configured' | 'error';
}

export interface UploadGitHubIssueAttachmentRequest {
  attachmentId: string;
  fullName: string;
  image: Blob;
}

export interface UploadGitHubIssueAttachmentOptions {
  apiBaseUrl?: string;
  currentHref?: string;
  fetchImplementation?: typeof fetch;
  getAuthToken?: () => Promise<string | null> | string | null;
  signal?: AbortSignal;
}

const maximumImageBytes = 10 * 1024 * 1024;
const mediaTypes = new Set<GitHubIssueAttachmentMediaType>([
  'image/gif',
  'image/jpeg',
  'image/png'
]);
const statuses = new Set<GitHubIssueAttachmentResult['status']>([
  'connected',
  'auth-required',
  'not-configured',
  'error'
]);
const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isValidRepositoryFullName(fullName: string) {
  const [owner, repository, extra] = fullName.split('/');
  return Boolean(
    !extra &&
      owner &&
      repository &&
      owner.length <= 39 &&
      repository.length <= 100 &&
      /^[A-Za-z0-9-]+$/.test(owner) &&
      /^[A-Za-z0-9._-]+$/.test(repository)
  );
}

function isGitHubImageUrl(value: unknown) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      (hostname === 'github.com' || hostname.endsWith('.githubusercontent.com'))
    );
  } catch {
    return false;
  }
}

function isResult(value: unknown): value is GitHubIssueAttachmentResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<GitHubIssueAttachmentResult>;

  if (
    typeof result.attachmentId !== 'string' ||
    typeof result.fullName !== 'string' ||
    !statuses.has(result.status as GitHubIssueAttachmentResult['status']) ||
    (result.message !== undefined && typeof result.message !== 'string')
  ) {
    return false;
  }

  if (result.status !== 'connected') {
    return true;
  }

  return (
    isGitHubImageUrl(result.markdownUrl) &&
    mediaTypes.has(result.mediaType as GitHubIssueAttachmentMediaType) &&
    Number.isSafeInteger(result.sizeBytes) &&
    (result.sizeBytes ?? 0) > 0 &&
    (result.sizeBytes ?? 0) <= maximumImageBytes
  );
}

function validateRequest({ attachmentId, fullName, image }: UploadGitHubIssueAttachmentRequest) {
  if (!attachmentIdPattern.test(attachmentId) || !isValidRepositoryFullName(fullName)) {
    throw new Error('The GitHub issue image request is invalid.');
  }
  if (
    !(image instanceof Blob) ||
    !mediaTypes.has(image.type as GitHubIssueAttachmentMediaType)
  ) {
    throw new Error('Paste a PNG, JPEG, or GIF image.');
  }
  if (!Number.isSafeInteger(image.size) || image.size <= 0 || image.size > maximumImageBytes) {
    throw new Error('Pasted images must be non-empty and 10 MiB or smaller.');
  }
}

export async function uploadGitHubIssueAttachment(
  request: UploadGitHubIssueAttachmentRequest,
  options: UploadGitHubIssueAttachmentOptions = {}
): Promise<GitHubIssueAttachmentResult> {
  validateRequest(request);

  const currentHref =
    options.currentHref ?? (typeof window === 'undefined' ? '' : window.location.href);
  if (!currentHref) {
    throw new Error('GitHub issue image requests require a browser URL.');
  }

  const explicitBaseUrl =
    options.apiBaseUrl ?? import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL;
  const baseUrl = resolveProjectSpaceApiBaseUrl(currentHref, explicitBaseUrl);
  const query = new URLSearchParams({
    attachmentId: request.attachmentId,
    fullName: request.fullName
  });
  const requestUrl = new URL(
    `${baseUrl}/api/github/issue-attachments?${query}`,
    currentHref
  );

  if (!isProjectSpaceApiRequestAllowed(currentHref, requestUrl.toString())) {
    throw new Error('Project Space refused an issue image request to an untrusted origin.');
  }

  const token = options.getAuthToken
    ? await options.getAuthToken()
    : await refreshProjectSpaceAuthToken();
  const response = await (options.fetchImplementation ?? globalThis.fetch)(requestUrl, {
    body: request.image,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': request.image.type
    },
    method: 'POST',
    redirect: 'error',
    signal: options.signal
  });
  const payload = (await response.json().catch(() => undefined)) as unknown;

  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error?: unknown }).error
        : undefined;
    throw new Error(
      typeof error === 'string' && error ? error : `Request failed with ${response.status}.`
    );
  }

  if (!isResult(payload)) {
    throw new Error('Project Space returned an invalid GitHub issue image response.');
  }
  if (
    payload.fullName !== request.fullName ||
    payload.attachmentId !== request.attachmentId
  ) {
    throw new Error('Project Space returned a different attachment request.');
  }
  if (
    payload.status === 'connected' &&
    (payload.mediaType !== request.image.type || payload.sizeBytes !== request.image.size)
  ) {
    throw new Error('Project Space returned an invalid GitHub issue image response.');
  }
  if (payload.status === 'connected') {
    const location = parseProjectSpaceGitHubIssueAttachmentUrl(
      payload.markdownUrl!,
      request.fullName
    );
    if (
      !location ||
      location.attachmentId !== request.attachmentId ||
      gitHubIssueAttachmentMediaType(location.extension) !== request.image.type
    ) {
      throw new Error('Project Space returned an invalid GitHub issue image response.');
    }
  }

  return payload;
}
