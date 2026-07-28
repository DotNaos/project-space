export const pullRequestChangelogSchema =
  'project-space.pr-preview-changelog/v1' as const;

export const pullRequestChangelogCategories = [
  'added',
  'changed',
  'fixed',
  'deprecated',
  'removed',
  'security'
] as const;

export type PullRequestChangelogCategory =
  (typeof pullRequestChangelogCategories)[number];

export interface PullRequestChangelogIdentity {
  headSha: string;
  pullRequestNumber: number;
  repositoryFullName: string;
}

export interface PullRequestChangelogEntry {
  category: PullRequestChangelogCategory;
  id: string;
  issueNumber?: number;
  pullRequestNumber: number;
  summary: string;
  testing: readonly string[];
}

interface PullRequestChangelogSnapshotBase
  extends PullRequestChangelogIdentity {
  schema: typeof pullRequestChangelogSchema;
}

export interface AvailablePullRequestChangelogSnapshot
  extends PullRequestChangelogSnapshotBase {
  docsHref: string;
  entries: readonly PullRequestChangelogEntry[];
  state: 'available';
}

export interface MissingPullRequestChangelogSnapshot
  extends PullRequestChangelogSnapshotBase {
  docsHref: string;
  entries: readonly [];
  reasonCode: 'no-entry';
  state: 'missing';
}

export interface InvalidPullRequestChangelogSnapshot
  extends PullRequestChangelogSnapshotBase {
  docsHref?: never;
  entries: readonly [];
  reasonCode: 'invalid-metadata' | 'source-unavailable';
  state: 'invalid';
}

export interface ContradictoryPullRequestChangelogSnapshot
  extends PullRequestChangelogSnapshotBase {
  docsHref?: never;
  entries: readonly [];
  reasonCode:
    | 'docs-link-mismatch'
    | 'entry-pr-mismatch'
    | 'identity-mismatch';
  state: 'contradictory';
}

export type PullRequestChangelogSnapshot =
  | AvailablePullRequestChangelogSnapshot
  | MissingPullRequestChangelogSnapshot
  | InvalidPullRequestChangelogSnapshot
  | ContradictoryPullRequestChangelogSnapshot;

export interface PullRequestChangelogPresentation {
  docsHref?: string;
  entries: readonly PullRequestChangelogEntry[];
  message?: string;
  state: PullRequestChangelogSnapshot['state'];
}

const fullSha = /^[0-9a-f]{40}$/i;
const repositoryFullName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function pullRequestChangelogDocsHref(
  pullRequestNumber: number
) {
  return `/docs/changelog?pr=${pullRequestNumber}`;
}

export function isPullRequestChangelogIdentity(
  identity: PullRequestChangelogIdentity
) {
  return (
    repositoryFullName.test(identity.repositoryFullName) &&
    Number.isSafeInteger(identity.pullRequestNumber) &&
    identity.pullRequestNumber > 0 &&
    fullSha.test(identity.headSha)
  );
}

export function samePullRequestChangelogIdentity(
  left: PullRequestChangelogIdentity,
  right: PullRequestChangelogIdentity
) {
  return (
    left.repositoryFullName.toLowerCase() ===
      right.repositoryFullName.toLowerCase() &&
    left.pullRequestNumber === right.pullRequestNumber &&
    left.headSha.toLowerCase() === right.headSha.toLowerCase()
  );
}

function safeDocsHref(snapshot: PullRequestChangelogSnapshot) {
  if (snapshot.state !== 'available' && snapshot.state !== 'missing') {
    return undefined;
  }
  const expected = pullRequestChangelogDocsHref(
    snapshot.pullRequestNumber
  );
  return snapshot.docsHref === expected ? expected : undefined;
}

const invalidMessages: Record<
  InvalidPullRequestChangelogSnapshot['reasonCode'],
  string
> = {
  'invalid-metadata':
    'The changelog metadata is invalid, so no testing guidance can be shown.',
  'source-unavailable':
    'The exact-source changelog is unavailable, so no testing guidance can be shown.'
};

const contradictoryMessage =
  'The changelog does not match this pull request revision, so its contents are hidden.';

export function pullRequestChangelogPresentation(
  snapshot: PullRequestChangelogSnapshot,
  expectedIdentity?: PullRequestChangelogIdentity
): PullRequestChangelogPresentation {
  if (
    !isPullRequestChangelogIdentity(snapshot) ||
    (expectedIdentity &&
      (!isPullRequestChangelogIdentity(expectedIdentity) ||
        !samePullRequestChangelogIdentity(snapshot, expectedIdentity)))
  ) {
    return {
      entries: [],
      message: contradictoryMessage,
      state: 'contradictory'
    };
  }

  if (snapshot.state === 'invalid') {
    return {
      entries: [],
      message: invalidMessages[snapshot.reasonCode],
      state: snapshot.state
    };
  }

  if (snapshot.state === 'contradictory') {
    return {
      entries: [],
      message: contradictoryMessage,
      state: snapshot.state
    };
  }

  const docsHref = safeDocsHref(snapshot);
  if (!docsHref) {
    return {
      entries: [],
      message: contradictoryMessage,
      state: 'contradictory'
    };
  }

  if (snapshot.state === 'missing') {
    return {
      docsHref,
      entries: [],
      message:
        'No changelog entry or testing guidance was documented for this pull request.',
      state: snapshot.state
    };
  }

  if (
    snapshot.entries.length === 0 ||
    snapshot.entries.some(
      (entry) =>
        entry.pullRequestNumber !== snapshot.pullRequestNumber
    )
  ) {
    return {
      entries: [],
      message: contradictoryMessage,
      state: 'contradictory'
    };
  }

  return {
    docsHref,
    entries: snapshot.entries,
    state: snapshot.state
  };
}
