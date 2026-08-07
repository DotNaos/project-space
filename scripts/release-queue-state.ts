import { expectedVersionForBump } from
  '../apps/docs/lib/releases/semver';
import type { ReleaseIntent } from
  '../apps/docs/lib/releases/release-intent';

export interface QueuedMerge {
  commit: string;
  intent: ReleaseIntent;
  pullRequest: number;
}

export interface PublishedRelease {
  commit: string;
  tag: string;
  version: string;
}

export interface ReservedTag {
  commit: string;
  tag: string;
}

export type QueueDecision =
  | { commit: string; kind: 'deploy'; release: PublishedRelease }
  | {
      intent: Exclude<ReleaseIntent, 'none'>;
      item: QueuedMerge;
      kind: 'release';
      tag: string;
      version: string;
    };

export function enforcedQueueCommits(input: {
  alreadyEnforced: boolean;
  commits: string[];
  enforcementIndex: number;
}) {
  if (input.commits.length === 0) return [];
  if (!input.alreadyEnforced && input.enforcementIndex < 0) {
    throw new Error(
      `Current main contains ${input.commits.length} post-release commit(s) but no release-intent enforcement marker.`,
    );
  }
  return input.commits.slice(
    input.alreadyEnforced ? 0 : input.enforcementIndex,
  );
}

export function releaseQueueDecision(input: {
  currentMain: string;
  merges: QueuedMerge[];
  published: PublishedRelease;
  reservations: ReservedTag[];
}): QueueDecision {
  const pending = input.merges.find((merge) => merge.intent !== 'none');
  if (!pending) {
    if (input.reservations.length > 0) {
      throw new Error(
        `Found ${input.reservations.length} unpublished release tag reservation(s) without a pending release intent.`,
      );
    }
    return {
      commit: input.currentMain,
      kind: 'deploy',
      release: input.published,
    };
  }

  const intent = pending.intent as Exclude<ReleaseIntent, 'none'>;
  const version = expectedVersionForBump(input.published.version, intent);
  const tag = `v${version}`;
  if (input.reservations.length > 1) {
    throw new Error(
      'More than one unpublished semantic release tag is reserved; queue ownership is ambiguous.',
    );
  }
  const reservation = input.reservations[0];
  if (
    reservation &&
    (reservation.tag !== tag || reservation.commit !== pending.commit)
  ) {
    throw new Error(
      `Reserved tag ${reservation.tag} at ${reservation.commit} does not match oldest queued intent ${tag} at ${pending.commit}.`,
    );
  }
  return { intent, item: pending, kind: 'release', tag, version };
}
