import { isChangelogVersion } from './changelog/semantic-version';

const fullCommitPattern = /^[0-9a-f]{40}$/i;
const previewHostPattern =
  /^pr-([1-9][0-9]*)\.projects\.os-home\.net$/i;
const productionHost = 'projects.os-home.net';
const projectRepository = 'dotnaos/project-space';

export type DocsDeploymentIdentity =
  | {
      backHref: '/';
      backLabel: 'Back to PR Preview';
      commit: string;
      pullRequestNumber: number;
      state: 'preview';
      version: string;
    }
  | {
      backHref: '/';
      backLabel: 'Back to Project Space';
      commit: string;
      state: 'production';
      version: string;
    }
  | DocsDeploymentIdentityUnavailable;

export interface DocsDeploymentIdentityUnavailable {
  backHref: '/';
  backLabel:
    | 'Back to PR Preview'
    | 'Back to Project Space';
  reasonCode:
    | 'identity-mismatch'
    | 'invalid-metadata'
    | 'missing-preview-identity'
    | 'request-failed';
  state: 'unavailable';
}

export interface DocsDeploymentPresentation {
  backHref: '/';
  backLabel:
    | 'Back to PR Preview'
    | 'Back to Project Space';
  contextLabel: string;
  fullRevision?: string;
  revision?: string;
  versionLabel: string;
}

export function resolveDocsDeploymentIdentity(
  metadata: unknown,
  hostname: string,
): DocsDeploymentIdentity {
  const normalizedHostname = normalizeHostname(hostname);
  const previewPullRequest = previewPullRequestFromHost(
    normalizedHostname,
  );
  const context = previewPullRequest
    ? 'preview'
    : normalizedHostname === productionHost
      ? 'production'
      : 'unknown';

  if (!isRecord(metadata)) {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'invalid-metadata',
    );
  }

  const version = normalizedString(metadata.version);
  const commit = normalizedString(metadata.commit)?.toLowerCase();
  if (
    !version ||
    !isChangelogVersion(version) ||
    !commit ||
    !fullCommitPattern.test(commit)
  ) {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'invalid-metadata',
    );
  }

  if (context === 'production') {
    if (metadata.preview !== undefined) {
      return unavailableDocsDeploymentIdentity(
        normalizedHostname,
        'identity-mismatch',
      );
    }
    return {
      backHref: '/',
      backLabel: 'Back to Project Space',
      commit,
      state: 'production',
      version,
    };
  }

  if (context !== 'preview' || !previewPullRequest) {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'identity-mismatch',
    );
  }

  if (metadata.preview === undefined) {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'missing-preview-identity',
    );
  }
  if (!isRecord(metadata.preview)) {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'invalid-metadata',
    );
  }
  if (metadata.preview.state !== 'verified') {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'identity-mismatch',
    );
  }

  const identity = metadata.preview.identity;
  if (!isRecord(identity)) {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'invalid-metadata',
    );
  }

  const headSha = normalizedString(identity.headSha)?.toLowerCase();
  const repositoryFullName = normalizedString(
    identity.repositoryFullName,
  )?.toLowerCase();
  if (
    !headSha ||
    !fullCommitPattern.test(headSha) ||
    identity.pullRequestNumber !== previewPullRequest ||
    repositoryFullName !== projectRepository ||
    headSha !== commit
  ) {
    return unavailableDocsDeploymentIdentity(
      normalizedHostname,
      'identity-mismatch',
    );
  }

  return {
    backHref: '/',
    backLabel: 'Back to PR Preview',
    commit,
    pullRequestNumber: previewPullRequest,
    state: 'preview',
    version,
  };
}

export function unavailableDocsDeploymentIdentity(
  hostname: string,
  reasonCode: DocsDeploymentIdentityUnavailable['reasonCode'],
): DocsDeploymentIdentityUnavailable {
  return {
    backHref: '/',
    backLabel: previewPullRequestFromHost(
      normalizeHostname(hostname),
    )
      ? 'Back to PR Preview'
      : 'Back to Project Space',
    reasonCode,
    state: 'unavailable',
  };
}

export function docsDeploymentPresentation(
  identity: DocsDeploymentIdentity,
): DocsDeploymentPresentation {
  if (identity.state === 'unavailable') {
    return {
      backHref: identity.backHref,
      backLabel: identity.backLabel,
      contextLabel: 'Docs deployment',
      versionLabel: 'Version unavailable',
    };
  }

  return {
    backHref: identity.backHref,
    backLabel: identity.backLabel,
    contextLabel:
      identity.state === 'preview'
        ? `PR #${identity.pullRequestNumber} Docs`
        : 'Production Docs',
    fullRevision: identity.commit,
    revision: identity.commit.slice(0, 8),
    versionLabel: `v${identity.version}`,
  };
}

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

function previewPullRequestFromHost(hostname: string) {
  const match = previewHostPattern.exec(hostname);
  if (!match) return undefined;
  const pullRequestNumber = Number(match[1]);
  return Number.isSafeInteger(pullRequestNumber)
    ? pullRequestNumber
    : undefined;
}

function normalizedString(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}
