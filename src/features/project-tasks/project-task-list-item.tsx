import { Tooltip } from '@heroui/react';
import {
  CircleDashed,
  CircleDot,
  CircleSlash2,
  CircleX,
  GitBranch,
  GitMerge,
  GitPullRequest
} from 'lucide-react';
import type { ProjectTaskViewModel } from './task-view-model';

function StatusIcon({ task }: { task: ProjectTaskViewModel }) {
  if (task.health === 'attention' || task.workflowMessage) {
    return <CircleX aria-label="Needs attention" className="size-4 shrink-0 text-red-400" />;
  }
  if (task.state === 'completed') {
    return <GitMerge aria-label="Completed" className="size-4 shrink-0 text-violet-400" />;
  }
  if (task.state === 'closed') {
    return <CircleSlash2 aria-label="Closed" className="size-4 shrink-0 text-neutral-400" />;
  }
  if (task.state === 'review') {
    return <CircleDot aria-label="Review" className="size-4 shrink-0 text-emerald-400" />;
  }
  if (task.state === 'active') {
    return <CircleDot aria-label="Active" className="size-4 shrink-0 text-blue-400" />;
  }
  return <CircleDashed aria-label="Backlog" className="size-4 shrink-0 text-neutral-600" />;
}

export function ProjectTaskListItem({
  mode = 'list',
  onOpen,
  task
}: {
  mode?: 'list' | 'tree';
  onOpen(): void;
  task: ProjectTaskViewModel;
}) {
  const pullRequest = task.pullRequest;
  const merged = pullRequest?.state === 'merged';
  const PullRequestIcon = merged ? GitMerge : GitPullRequest;
  const subIssueProgress = task.issue.subIssueProgress;

  return (
    <button
      aria-label={`Open task #${task.issue.number}: ${task.issue.title}`}
      className={`group block min-h-11 w-full text-left transition-[background-color,scale] active:scale-[.99] ${mode === 'tree' ? 'rounded-lg px-2.5 py-2 hover:bg-current/[.045] @xl:px-3' : 'border-b border-current/[.07] px-1 py-2 hover:bg-current/[.018] @xl:px-3'}`}
      onClick={onOpen}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] tabular-nums text-current/30">#{task.issue.number}</span>
        <StatusIcon task={task} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-current/85 group-hover:text-current">{task.issue.title}</span>
        </span>
        {subIssueProgress ? (
          <span
            aria-label={`Sub-tasks ${subIssueProgress.completed} of ${subIssueProgress.total} complete`}
            className="hidden shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-current/45 sm:flex"
          >
            <span aria-hidden="true" className="h-1 w-12 overflow-hidden rounded-full bg-current/[.08]">
              <span
                className="block h-full rounded-full bg-current/45"
                style={{ width: `${subIssueProgress.percentCompleted}%` }}
              />
            </span>
            {subIssueProgress.completed}/{subIssueProgress.total}
          </span>
        ) : null}
        {pullRequest ? (
          <span className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${merged ? 'bg-violet-500/[.12] text-violet-300' : pullRequest.isDraft ? 'bg-current/[.055] text-current/40' : 'bg-emerald-500/[.12] text-emerald-300'}`}>
            <PullRequestIcon className="size-3" />#{pullRequest.number}
          </span>
        ) : task.state === 'active' && task.branch ? (
          <Tooltip delay={300}>
            <Tooltip.Trigger>
              <span aria-label="Branch active" className="flex shrink-0 items-center text-blue-400">
                <GitBranch className="size-3.5" />
              </span>
            </Tooltip.Trigger>
            <Tooltip.Content placement="top">Branch active</Tooltip.Content>
          </Tooltip>
        ) : null}
      </span>
      {task.workflowMessage ? (
        <span className="mt-1.5 block ps-6 text-[11px] leading-4 text-amber-300/80">
          {task.workflowMessage}
        </span>
      ) : null}
    </button>
  );
}
