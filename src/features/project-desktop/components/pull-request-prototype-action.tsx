import { ExternalLink, RefreshCw, Shapes } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import {
  buildPrototypeReviewHref,
  prototypeLaunchStatus,
  type PrototypeLaunchIdentity,
  type PrototypeLaunchState
} from '@/shared/prototype-launch';
import type { GitHubPullRequestRecord } from '@/shared/project-space-api';
import { usePullRequestPrototypeLaunch } from '../hooks/use-pull-request-prototype-launch';

const stateTone: Record<PrototypeLaunchState, string> = {
  'not-started': 'text-neutral-500',
  ready: 'text-emerald-300',
  starting: 'text-sky-300',
  stale: 'text-amber-300',
  stopped: 'text-neutral-400',
  unavailable: 'text-rose-300'
};

export function PullRequestPrototypeAction({
  issueNumber,
  projectId,
  pullRequest,
  repositoryFullName
}: {
  issueNumber?: number;
  projectId: string;
  pullRequest: GitHubPullRequestRecord;
  repositoryFullName: string;
}) {
  const canIdentify = Boolean(pullRequest.headSha);
  const query = usePullRequestPrototypeLaunch({
    enabled: canIdentify,
    pullRequestNumber: pullRequest.number,
    repositoryFullName
  });
  const live = query.result?.liveContext.state === 'available'
    ? query.result.liveContext
    : undefined;
  const identity = pullRequest.headSha
    ? {
        branchName: live?.branchName ?? pullRequest.headBranch,
        headSha: pullRequest.headSha,
        issueNumber,
        machineId: live?.machineId,
        projectId,
        pullRequestNumber: pullRequest.number,
        repositoryFullName,
        surface: live?.servedSurface ?? 'desktop-prototype',
        threadId: query.result?.feedback.state === 'available'
          ? query.result.feedback.threadId
          : undefined,
        worktreeId: live?.worktreeId
      } satisfies PrototypeLaunchIdentity
    : undefined;
  const status = prototypeLaunchStatus({
    error: query.error,
    identity,
    isLoading: query.isLoading,
    result: query.result
  });
  const href = identity ? buildPrototypeReviewHref(identity) : undefined;
  const isBusy = status.state === 'starting';

  return (
    <div className="grid min-w-0 gap-1.5 border-t border-neutral-800/70 pt-2">
      <div className="flex min-w-0 items-center gap-2">
        <Shapes aria-hidden className="size-3.5 shrink-0 text-neutral-500" />
        <Text className={`min-w-0 flex-1 text-xs ${stateTone[status.state]}`}>
          Prototype · {status.state.replace('-', ' ')}
        </Text>
        {query.error || status.state === 'stale' || status.state === 'stopped' ? (
          <Button
            aria-label="Retry prototype status"
            isDisabled={query.isLoading}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => void query.refresh()}
          >
            <RefreshCw className={query.isLoading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
        ) : null}
      </div>
      <Text className="text-[11px] leading-4 text-neutral-600">{status.message}</Text>
      <Button
        className="w-full"
        isDisabled={!href || isBusy}
        size="sm"
        variant={status.state === 'ready' ? 'primary' : 'secondary'}
        onPress={() => {
          if (href) window.location.assign(href);
        }}
      >
        {status.state === 'ready'
          ? <><ExternalLink className="size-3.5" />Open prototype</>
          : <><Shapes className="size-3.5" />Start prototype</>}
      </Button>
    </div>
  );
}
