import {
  GITHUB_ISSUE_ATTACHMENT_CONTENT_PATH,
  gitHubIssueAttachmentMediaType,
  parseProjectSpaceGitHubIssueAttachmentUrl
} from '../shared/github-issue-attachment-location';
import {
  isProjectSpaceApiRequestAllowed,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from './project-space-client';

export interface LoadGitHubIssueAttachmentContentOptions {
  apiBaseUrl?: string;
  currentHref?: string;
  fetchImplementation?: typeof fetch;
  getAuthToken?: () => Promise<string | null> | string | null;
  signal?: AbortSignal;
}

const maximumImageBytes = 10 * 1024 * 1024;

async function readBoundedImage(
  response: Response,
  mediaType: string,
  declaredSize: number | undefined
) {
  if (!response.body) throw new Error('Project Space returned an invalid issue image.');

  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumImageBytes) {
        await reader.cancel();
        throw new Error('Project Space returned an invalid issue image.');
      }
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy.buffer);
    }
  } finally {
    reader.releaseLock();
  }

  if (size <= 0 || (declaredSize !== undefined && declaredSize !== size)) {
    throw new Error('Project Space returned an invalid issue image.');
  }
  return new Blob(chunks, { type: mediaType });
}

export function githubIssueAttachmentContentUrl(
  markdownUrl: string,
  repositoryFullName: string
) {
  const location = parseProjectSpaceGitHubIssueAttachmentUrl(
    markdownUrl,
    repositoryFullName
  );
  if (!location) return undefined;

  const search = new URLSearchParams({
    attachmentId: location.attachmentId,
    commitSha: location.commitSha,
    extension: location.extension,
    fullName: location.fullName,
    issueNumber: String(location.issueNumber)
  });
  return `${GITHUB_ISSUE_ATTACHMENT_CONTENT_PATH}?${search.toString()}`;
}

export async function loadGitHubIssueAttachmentContent(
  markdownUrl: string,
  repositoryFullName: string,
  options: LoadGitHubIssueAttachmentContentOptions = {}
) {
  const location = parseProjectSpaceGitHubIssueAttachmentUrl(
    markdownUrl,
    repositoryFullName
  );
  const relativeUrl = githubIssueAttachmentContentUrl(
    markdownUrl,
    repositoryFullName
  );
  if (!location || !relativeUrl) {
    throw new Error('The issue image request is invalid.');
  }

  const currentHref =
    options.currentHref ?? (typeof window === 'undefined' ? '' : window.location.href);
  if (!currentHref) throw new Error('Issue images require a browser URL.');

  const explicitBaseUrl =
    options.apiBaseUrl ?? import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL;
  const baseUrl = resolveProjectSpaceApiBaseUrl(currentHref, explicitBaseUrl);
  const requestUrl = new URL(`${baseUrl}${relativeUrl}`, currentHref);
  if (!isProjectSpaceApiRequestAllowed(currentHref, requestUrl.toString())) {
    throw new Error('Project Space refused an issue image request to an untrusted origin.');
  }

  const token = options.getAuthToken
    ? await options.getAuthToken()
    : await refreshProjectSpaceAuthToken();
  const expectedMediaType = gitHubIssueAttachmentMediaType(location.extension);
  const response = await (options.fetchImplementation ?? globalThis.fetch)(requestUrl, {
    cache: 'no-store',
    headers: {
      Accept: expectedMediaType,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    method: 'GET',
    redirect: 'error',
    signal: options.signal
  });
  if (!response.ok) throw new Error('Could not load this issue image.');

  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const declaredSize = response.headers.get('content-length');
  const parsedDeclaredSize = declaredSize === null ? undefined : Number(declaredSize);
  if (
    mediaType !== expectedMediaType
    || (declaredSize !== null
      && (!/^(0|[1-9]\d*)$/.test(declaredSize)
        || !Number.isSafeInteger(parsedDeclaredSize)
        || parsedDeclaredSize! > maximumImageBytes))
  ) {
    throw new Error('Project Space returned an invalid issue image.');
  }

  return readBoundedImage(response, expectedMediaType, parsedDeclaredSize);
}
