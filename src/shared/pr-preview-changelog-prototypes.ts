import {
  isPullRequestChangelogIdentity,
  pullRequestChangelogPresentation,
  samePullRequestChangelogIdentity,
  type PullRequestChangelogEntry,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogPrototypeSurface,
  type PullRequestChangelogSnapshot
} from './pr-preview-changelog-api';

export const pullRequestPrototypeSurfaceLabels: Record<
  PullRequestChangelogPrototypeSurface,
  string
> = {
  'desktop-prototype': 'Desktop prototype',
  'mobile-prototype': 'Mobile prototype'
};

export type PullRequestChangelogPrototypeSelection =
  | {
      entry: PullRequestChangelogEntry;
      state: 'ready';
    }
  | {
      message: string;
      state: 'missing' | 'unknown' | 'unavailable';
    };

export function pullRequestChangelogPrototypeSelection(
  snapshot: PullRequestChangelogSnapshot,
  expectedIdentity: PullRequestChangelogIdentity,
  changeId: string | undefined
): PullRequestChangelogPrototypeSelection {
  if (!changeId) {
    return {
      message: 'Choose a Change from the pull request changelog.',
      state: 'missing'
    };
  }

  const presentation = pullRequestChangelogPresentation(
    snapshot,
    expectedIdentity
  );
  if (presentation.state !== 'available') {
    return {
      message:
        presentation.message ??
        'The exact-source changelog is unavailable for this pull request revision.',
      state: 'unavailable'
    };
  }

  const entry = presentation.entries.find(
    (candidate) => candidate.id === changeId
  );
  if (!entry?.prototype) {
    return {
      message:
        'This Change does not identify a testable prototype in the exact pull request revision.',
      state: 'unknown'
    };
  }

  return { entry, state: 'ready' };
}

export function pullRequestPrototypeReviewHref(
  identity: PullRequestChangelogIdentity,
  entry: PullRequestChangelogEntry,
  options?: { target?: string }
) {
  if (
    !isPullRequestChangelogIdentity(identity) ||
    entry.pullRequestNumber !== identity.pullRequestNumber ||
    !entry.prototype
  ) {
    return undefined;
  }

  const params = new URLSearchParams();
  params.set('repository', identity.repositoryFullName);
  params.set('pr', String(identity.pullRequestNumber));
  params.set('head', identity.headSha.toLowerCase());
  params.set('change', entry.id);
  params.set(
    'surface',
    entry.prototype.surface === 'mobile-prototype' ? 'native' : 'web'
  );
  params.set('viewport', entry.prototype.viewport);
  if (options?.target?.trim()) {
    params.set('target', options.target.trim());
  }
  return `/prototype-review?${params}`;
}

export function pullRequestPrototypeIdentityMatches(
  identity: PullRequestChangelogIdentity,
  candidate:
    | PullRequestChangelogIdentity
    | undefined
) {
  return Boolean(
    candidate &&
      isPullRequestChangelogIdentity(candidate) &&
      samePullRequestChangelogIdentity(identity, candidate)
  );
}
