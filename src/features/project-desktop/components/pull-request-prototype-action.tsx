import { Bot, ExternalLink, RefreshCw, Shapes } from 'lucide-react';

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
  connectorId,
  issueNumber,
  projectId,
  pullRequest,
  repositoryFullName
}: {
  connectorId?: string;
  issueNumber?: number;
  projectId: string;
  pullRequest: GitHubPullRequestRecord;
  repositoryFullName: string;
}) {
  const canIdentify = Boolean(pullRequest.headSha);
  const query = usePullRequestPrototypeLaunch({
    branchName: pullRequest.headBranch,
    connectorId,
    enabled: canIdentify,
    headSha: pullRequest.headSha,
    issueNumber,
    pullRequestNumber: pullRequest.number,
    repositoryFullName
  });
  const live = query.result?.liveContext.state === 'available'
    ? query.result.liveContext
    : undefined;
  const identity = pullRequest.headSha
    ? {
        branchName: live?.branchName ?? pullRequest.headBranch,
        connectorId: live?.connectorId ?? connectorId,
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
    error: query.startResult?.state === 'blocked' ||
        query.startResult?.state === 'uncertain'
      ? query.startResult.message
      : query.error,
    identity,
    isLoading: query.isLoading || query.isStarting,
    result: query.result
  });
  const href = identity ? buildPrototypeReviewHref(identity) : undefined;
  const task = query.startResult?.state === 'confirmed'
    ? query.startResult.task
    : undefined;
  const canStart = Boolean(
    issueNumber && pullRequest.headBranch && pullRequest.headSha
  );
  const isBusy = query.isStarting;
  const actionLabel = status.state === 'ready'
    ? 'Open prototype'
    : task
      ? 'Open Codex task'
      : status.state === 'stopped'
        ? 'Resume prototype task'
        : status.state === 'stale'
          ? 'Reconnect exact head'
          : 'Start prototype';

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
      {task ? (
        <Text className="text-[11px] leading-4 text-emerald-300">
          Task #{task.issue.number} is linked on {task.physicalMachine.name}.
        </Text>
      ) : null}
      <Button
        className="w-full"
        isDisabled={isBusy || (status.state === 'ready' ? !href : !task && !canStart)}
        size="sm"
        variant={status.state === 'ready' ? 'primary' : 'secondary'}
        onPress={() => {
          if (status.state === 'ready' && href) {
            window.location.assign(href);
          } else if (task) {
            window.location.assign(task.canonicalTaskUrl);
          } else {
            void query.startOrReuseTask();
          }
        }}
      >
        {isBusy
          ? <><RefreshCw className="size-3.5 animate-spin" />Starting task…</>
          : status.state === 'ready'
            ? <><ExternalLink className="size-3.5" />{actionLabel}</>
            : task
              ? <><Bot className="size-3.5" />{actionLabel}</>
              : <><Shapes className="size-3.5" />{actionLabel}</>}
      </Button>
    </div>
  );
}
