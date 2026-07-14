export const GITHUB_ISSUE_ATTACHMENT_CONTENT_PATH =
  '/api/github/issue-attachment-content';

export type GitHubIssueAttachmentExtension = 'gif' | 'jpg' | 'png';

export interface GitHubIssueAttachmentLocation {
  attachmentId: string;
  commitSha: string;
  extension: GitHubIssueAttachmentExtension;
  fullName: string;
}

const attachmentIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const commitShaPattern = /^[0-9a-f]{40}$/;
const repositoryOwnerPattern =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9._-]+$/;

export function isGitHubIssueAttachmentLocation(
  value: unknown
): value is GitHubIssueAttachmentLocation {
  if (!value || typeof value !== 'object') return false;

  const location = value as Partial<GitHubIssueAttachmentLocation>;
  return (
    typeof location.attachmentId === 'string'
    && attachmentIdPattern.test(location.attachmentId)
    && typeof location.commitSha === 'string'
    && commitShaPattern.test(location.commitSha)
    && isGitHubIssueAttachmentExtension(location.extension)
    && typeof location.fullName === 'string'
    && isGitHubRepositoryFullName(location.fullName)
  );
}

export function isGitHubRepositoryFullName(value: string) {
  if (value.length > 140) return false;

  const [owner, repository, extra] = value.split('/');
  return (
    Boolean(owner)
    && Boolean(repository)
    && !extra
    && repositoryOwnerPattern.test(owner)
    && repository !== '.'
    && repository !== '..'
    && repository.length <= 100
    && repositoryNamePattern.test(repository)
  );
}

export function gitHubIssueAttachmentMediaType(
  extension: GitHubIssueAttachmentExtension
) {
  if (extension === 'gif') return 'image/gif' as const;
  if (extension === 'jpg') return 'image/jpeg' as const;
  return 'image/png' as const;
}

export function gitHubIssueAttachmentRepositoryPath(
  location: Pick<GitHubIssueAttachmentLocation, 'attachmentId' | 'extension'>
) {
  return (
    '.github/project-space/issue-attachments/'
    + `${location.attachmentId}.${location.extension}`
  );
}

export function parseProjectSpaceGitHubIssueAttachmentUrl(
  value: string,
  repositoryFullName: string
): GitHubIssueAttachmentLocation | null {
  if (
    !isGitHubRepositoryFullName(repositoryFullName)
    || !value
    || /[\u0000-\u0020\u007f\\]/.test(value)
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'github.com'
      || url.username
      || url.password
      || url.port
      || url.hash
      || url.search !== '?raw=1'
    ) {
      return null;
    }

    const prefix = `/${repositoryFullName}/blob/`;
    if (!url.pathname.startsWith(prefix)) return null;

    const immutablePath = url.pathname.slice(prefix.length);
    const separator = immutablePath.indexOf('/');
    if (separator < 0) return null;

    const commitSha = immutablePath.slice(0, separator);
    const attachmentPath = immutablePath.slice(separator + 1);
    const attachmentMatch = attachmentPath.match(
      /^\.github\/project-space\/issue-attachments\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(gif|jpg|png)$/
    );
    if (!attachmentMatch || !commitShaPattern.test(commitSha)) return null;

    return {
      attachmentId: attachmentMatch[1],
      commitSha,
      extension: attachmentMatch[2] as GitHubIssueAttachmentExtension,
      fullName: repositoryFullName
    };
  } catch {
    return null;
  }
}

export function parseGitHubIssueAttachmentContentSearch(
  searchParams: URLSearchParams
): GitHubIssueAttachmentLocation | null {
  const expectedKeys = new Set([
    'attachmentId',
    'commitSha',
    'extension',
    'fullName'
  ]);
  const entries = Array.from(searchParams.entries());
  if (
    entries.length !== expectedKeys.size
    || entries.some(([key]) => !expectedKeys.has(key))
  ) {
    return null;
  }

  const location = {
    attachmentId: searchParams.get('attachmentId'),
    commitSha: searchParams.get('commitSha'),
    extension: searchParams.get('extension'),
    fullName: searchParams.get('fullName')
  };

  return isGitHubIssueAttachmentLocation(location) ? location : null;
}

function isGitHubIssueAttachmentExtension(
  value: unknown
): value is GitHubIssueAttachmentExtension {
  return value === 'gif' || value === 'jpg' || value === 'png';
}
