import { useEffect, useState } from 'react';

import {
  pullRequestChangelogSnapshotFor,
  pullRequestChangelogSnapshotFromSource
} from '@/features/pr-preview-changelog/pull-request-changelog-snapshot';
import {
  isPullRequestChangelogIdentity,
  samePullRequestChangelogIdentity,
  type PullRequestChangelogIdentity,
  type PullRequestChangelogSnapshot
} from '@/shared/pr-preview-changelog-api';
import { pullRequestChangelogPrototypeSelection } from '@/shared/pr-preview-changelog-prototypes';

interface ExactChangelogResponse {
  identity?: PullRequestChangelogIdentity;
  source?: unknown;
}

function exactPreviewOrigin(pullRequestNumber: number) {
  return `https://pr-${pullRequestNumber}.projects.os-home.net`;
}

export function useExactPullRequestChangelog(
  identity: PullRequestChangelogIdentity | undefined
) {
  const [snapshot, setSnapshot] = useState<PullRequestChangelogSnapshot>();

  useEffect(() => {
    setSnapshot(undefined);
    if (!identity) {
      return;
    }
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(
          `${exactPreviewOrigin(identity.pullRequestNumber)}/api/app/changelog`,
          {
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal
          }
        );
        if (!response.ok) return;
        const payload = await response.json() as ExactChangelogResponse;
        if (
          !payload.identity ||
          !isPullRequestChangelogIdentity(payload.identity) ||
          !samePullRequestChangelogIdentity(payload.identity, identity)
        ) return;
        const next = pullRequestChangelogSnapshotFromSource(
          identity,
          payload.source
        );
        if (active) setSnapshot(next);
      } catch {
        // The bundled exact-source snapshot remains the fail-closed fallback.
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [identity]);

  return snapshot;
}

export function usePullRequestReviewChangelog(
  identity: PullRequestChangelogIdentity | undefined,
  changeId: string | undefined
) {
  const exactSnapshot = useExactPullRequestChangelog(identity);
  const snapshot = identity
    ? exactSnapshot ?? pullRequestChangelogSnapshotFor(identity)
    : undefined;
  const selection = identity && snapshot
    ? pullRequestChangelogPrototypeSelection(snapshot, identity, changeId)
    : {
        message: 'A verified repository, pull request, and full head revision are required.',
        state: 'unavailable' as const
      };
  return { exactSnapshot, selection, snapshot };
}
