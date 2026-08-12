import { expectedVersionForBump } from
  '../apps/docs/lib/releases/semver';
import type { ReleaseIntent } from
  '../apps/docs/lib/releases/release-intent';
import type { ReleaseBump } from
  '../apps/docs/lib/releases/types';
import type { UnpublishedReleaseTombstone } from './release-tombstone';

export interface QueuedMerge {
  commit: string;
  bump?: ReleaseBump;
  /** Historical compatibility for commits created before changelog/<PR>.md. */
  intent?: ReleaseIntent;
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
      bump: ReleaseBump;
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
      `Current main contains ${input.commits.length} post-release commit(s) but no release queue enforcement marker.`,
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
  tombstones?: UnpublishedReleaseTombstone[];
}): QueueDecision {
  const tombstones = input.tombstones ?? [];
  if (tombstones.length > 1) {
    throw new Error(
      'More than one unpublished release tombstone is active; recovery ownership is ambiguous.',
    );
  }
  const pending = input.merges.find((merge) => releaseBumpFor(merge));
  if (!pending) {
    if (tombstones.length === 1) {
      throw new Error(
        `Tombstone ${tombstones[0].tag} has no queued release source.`,
      );
    }
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

  const bump = releaseBumpFor(pending)!;
  const version = expectedVersionForBump(input.published.version, bump);
  const tag = `v${version}`;
  const tombstone = tombstones[0];
  if (tombstone) {
    if (tombstone.tag !== tag || tombstone.sourceCommit !== pending.commit) {
      throw new Error(
        `Tombstone ${tombstone.tag} at ${tombstone.sourceCommit} does not match oldest queued bump ${tag} at ${pending.commit}.`,
      );
    }
    if (!input.reservations.some((reservation) =>
      reservation.tag === tombstone.tag &&
      reservation.commit === tombstone.sourceCommit
    )) {
      throw new Error(
        `Tombstone ${tombstone.tag} has no exact immutable tag reservation.`,
      );
    }
    const remaining = input.merges.slice(input.merges.indexOf(pending) + 1);
    const catchUpBump = combinedBump(remaining);
    if (!catchUpBump) {
      throw new Error(
        `Tombstone ${tombstone.tag} has no later release-bearing merge for a catch-up release.`,
      );
    }
    const catchUpVersion = expectedVersionForBump(version, catchUpBump);
    const catchUpTag = `v${catchUpVersion}`;
    const activeReservations = input.reservations.filter((reservation) =>
      reservation.tag !== tombstone.tag ||
      reservation.commit !== tombstone.sourceCommit
    );
    if (activeReservations.length > 1) {
      throw new Error(
        'More than one catch-up semantic release tag is reserved; queue ownership is ambiguous.',
      );
    }
    const active = activeReservations[0];
    if (
      active &&
      (active.tag !== catchUpTag || active.commit !== input.currentMain)
    ) {
      throw new Error(
        `Reserved catch-up tag ${active.tag} at ${active.commit} does not match ${catchUpTag} at current main ${input.currentMain}.`,
      );
    }
    const item = input.merges.at(-1);
    if (!item || item.commit !== input.currentMain) {
      throw new Error(
        'Catch-up release source must be the exact current main queue item.',
      );
    }
    return {
      bump: catchUpBump,
      item,
      kind: 'release',
      tag: catchUpTag,
      version: catchUpVersion,
    };
  }
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
      `Reserved tag ${reservation.tag} at ${reservation.commit} does not match oldest queued bump ${tag} at ${pending.commit}.`,
    );
  }
  return { bump, item: pending, kind: 'release', tag, version };
}

function releaseBumpFor(merge: QueuedMerge): ReleaseBump | undefined {
  if (merge.bump) return merge.bump;
  if (merge.intent && merge.intent !== 'none') return merge.intent;
  return undefined;
}

function combinedBump(merges: QueuedMerge[]): ReleaseBump | undefined {
  const bumps = merges.flatMap((merge) => {
    const bump = releaseBumpFor(merge);
    return bump ? [bump] : [];
  });
  if (bumps.includes('major')) return 'major';
  if (bumps.includes('minor')) return 'minor';
  if (bumps.includes('patch')) return 'patch';
  return undefined;
}
