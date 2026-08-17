import { useState } from 'react';
import { Avatar, Button, Chip } from '@heroui/react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  CircleDot,
  CircleSlash2,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Bot,
  Send
} from 'lucide-react';
import type {
  GitHubIssueCommentRecord,
  GitHubSubIssueProgress,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { IssueMarkdown } from '@/features/project-desktop/components/issue-markdown';
import { IssueLabelChip } from '@/features/project-desktop/components/issue-visuals';
import { useRuntimeBinding } from '@/features/project-desktop/components/runtime-binding-context';
import type { CodexThreadOrigin } from '@/features/codex-sessions/codex-sessions-types';
import { ProjectTaskDetailTabs } from './project-task-detail-tabs';
import { ProjectTaskPipelinePanel } from './project-task-pipeline-panel';
import { ProjectTaskRunnerPanel } from './project-task-runner-panel';
import { ProjectTaskListItem } from './project-task-list-item';
import { pullRequestChipPresentation } from './project-task-presentation';
import type { ProjectTaskViewModel } from './task-view-model';

function taskStateLabel(task: ProjectTaskViewModel) {
  if (task.health === 'attention' || task.workflowMessage) return 'Needs attention';
  if (task.state === 'completed') return 'Completed';
  if (task.state === 'closed') return 'Closed';
  if (task.state === 'review') return 'Review';
  if (task.state === 'active') return 'Active';
  return 'Backlog';
}

function TaskStateChipIcon({ task }: { task: ProjectTaskViewModel }) {
  const className = 'size-3.5 shrink-0 text-white';
  if (task.health === 'attention' || task.workflowMessage) {
    return <CircleX aria-hidden className={className} />;
  }
  if (task.state === 'completed') return <GitMerge aria-hidden className={className} />;
  if (task.state === 'closed') return <CircleSlash2 aria-hidden className={className} />;
  if (task.state === 'review' || task.state === 'active') {
    return <CircleDot aria-hidden className={className} />;
  }
  return <CircleDashed aria-hidden className={className} />;
}

function taskStateChip(task: ProjectTaskViewModel): {
  className?: string;
  color: 'accent' | 'danger' | 'default' | 'success';
} {
  if (task.health === 'attention' || task.workflowMessage) return { color: 'danger' };
  if (task.state === 'completed') return { className: '!bg-violet-500', color: 'default' };
  if (task.state === 'closed') return { className: '!bg-neutral-500', color: 'default' };
  if (task.state === 'review') return { color: 'success' };
  if (task.state === 'active') return { color: 'accent' };
  return { className: '!bg-neutral-600', color: 'default' };
}

function SubTaskProgressIndicator({ progress }: { progress: GitHubSubIssueProgress }) {
  return (
    <span
      aria-label={`Sub-tasks ${progress.completed} of ${progress.total} complete`}
      className="flex shrink-0 items-center gap-2 rounded-full bg-current/[.05] px-2.5 py-1 text-xs tabular-nums text-current/55"
    >
      <span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-current/[.1]">
        <span
          className="block h-full rounded-full bg-current/55"
          style={{ width: `${progress.percentCompleted}%` }}
        />
      </span>
      {progress.completed}/{progress.total} complete
    </span>
  );
}

function SubIssueList({ onOpenTask, subIssueProgress, subIssues }: {
  onOpenTask(issueNumber: number): void;
  subIssueProgress?: GitHubSubIssueProgress;
  subIssues: ProjectTaskViewModel[];
}) {
  if (subIssues.length === 0) return null;

  return (
    <section className="mt-7 border-t border-current/[.08] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-current/85">Sub-tasks</h2>
        <div className="flex items-center gap-2">
          {subIssueProgress ? <SubTaskProgressIndicator progress={subIssueProgress} /> : null}
          <span className="rounded-full bg-current/[.05] px-2.5 py-1 text-xs tabular-nums text-current/50">
            {subIssues.length}
          </span>
        </div>
      </div>
      <ul aria-label="Sub-tasks" className="mt-3">
        {subIssues.map((subIssue) => (
          <li key={subIssue.issue.number}>
            <ProjectTaskListItem onOpen={() => onOpenTask(subIssue.issue.number)} task={subIssue} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CommentTimeline({ comments, repositoryFullName }: {
  comments: GitHubIssueCommentRecord[];
  repositoryFullName?: string;
}) {
  if (comments.length === 0) {
    return <p className="py-3 text-sm text-current/35">No comments yet.</p>;
  }
  return (
    <div className="divide-y divide-current/[.07]">
      {comments.map((comment) => (
        <article className="py-4" key={comment.id}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Avatar className="shrink-0" size="sm">
                {comment.authorAvatarUrl ? (
                  <Avatar.Image
                    alt={`${comment.author ?? 'GitHub user'} profile picture`}
                    loading="lazy"
                    src={comment.authorAvatarUrl}
                  />
                ) : null}
                <Avatar.Fallback className="text-[10px] font-semibold uppercase">
                  {(comment.author ?? 'G').slice(0, 1)}
                </Avatar.Fallback>
              </Avatar>
              <span className="truncate text-xs font-medium text-current/65">
                {comment.author ?? 'GitHub user'}
              </span>
            </div>
            <time className="shrink-0 text-xs text-current/40">
              {comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : ''}
            </time>
          </div>
          <IssueMarkdown className="mt-2 text-sm leading-6 text-current/75" markdown={comment.body} repositoryFullName={repositoryFullName} />
        </article>
      ))}
    </div>
  );
}

export function ProjectTaskDetail({
  addComment,
  comments,
  isLoadingComments,
  onBack,
  onNewCodexTask,
  onOpenCodex,
  onOpenTask,
  project,
  repositoryFullName,
  subIssues,
  task
}: {
  addComment(body: string): Promise<void>;
  comments: GitHubIssueCommentRecord[];
  isLoadingComments: boolean;
  onBack(): void;
  onNewCodexTask(): void;
  onOpenCodex(origin: CodexThreadOrigin): void;
  onOpenTask(issueNumber: number): void;
  project: ProjectSpaceRecord;
  repositoryFullName?: string;
  subIssues: ProjectTaskViewModel[];
  task: ProjectTaskViewModel;
}) {
  const runtime = useRuntimeBinding();
  const [commentBody, setCommentBody] = useState('');
  const [commentError, setCommentError] = useState('');
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const pullRequest = task.pullRequest;
  const hasLongDescription = (task.issue.body?.length ?? 0) > 420;
  const stateChip = taskStateChip(task);
  const pullRequestChip = pullRequest ? pullRequestChipPresentation(pullRequest) : undefined;
  const parentIssue = task.issue.parentIssue;
  const subIssueProgress = task.issue.subIssueProgress;

  async function submitComment() {
    if (!commentBody.trim() || isPosting) return;
    setIsPosting(true);
    setCommentError('');
    try {
      await addComment(commentBody);
      setCommentBody('');
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : 'Could not add comment.');
    } finally {
      setIsPosting(false);
    }
  }

  return (
    <section className="mx-auto h-full min-h-0 w-full max-w-5xl overflow-y-auto px-5 pb-5 pt-2 [scrollbar-width:none] @md:px-8 @3xl:px-10">
      <header className="border-b border-current/[.08] pb-5">
        <div className="flex items-center justify-between gap-3">
          <button className="inline-flex items-center gap-2 rounded-full px-2 py-1.5 text-sm text-current/70 hover:bg-current/[.06] hover:text-current" onClick={onBack} type="button">
            <ArrowLeft className="size-4" /> Tasks
          </button>
          <div className="flex items-center gap-1.5">
            <Button onPress={onNewCodexTask} size="sm" variant="secondary">
              <Bot className="size-4" />
              New Codex task
            </Button>
            {runtime.apis === 'external' && task.issue.url ? (
              <a aria-label="Open issue on GitHub" className="rounded-full p-2 text-current/35 hover:bg-current/[.06] hover:text-current" href={task.issue.url} rel="noreferrer" target="_blank">
                <ExternalLink className="size-4" />
              </a>
            ) : null}
          </div>
        </div>
        <div className="mt-4 min-w-0">
          <h1 className="text-2xl font-semibold leading-tight tracking-[-.035em] @lg:text-3xl">{task.issue.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm tabular-nums">
            <span className="text-current/30">#{task.issue.number}</span>
            <span aria-hidden className="text-current/20">·</span>
            <Chip
              className={stateChip.className}
              color={stateChip.color}
              size="md"
              variant="primary"
            >
              <TaskStateChipIcon task={task} />
              <Chip.Label className="!text-white">{taskStateLabel(task)}</Chip.Label>
            </Chip>
            {pullRequest && pullRequestChip ? (
              runtime.apis === 'external' && pullRequest.url ? (
                <a aria-label={`Open ${pullRequestChip.label}`} href={pullRequest.url} rel="noreferrer" target="_blank">
                  <Chip className={pullRequestChip.className} color={pullRequestChip.color} size="md" variant="primary">
                    {pullRequestChip.icon === 'merged' ? <GitMerge aria-hidden className="size-3.5 text-white" /> : pullRequestChip.icon === 'draft' ? <GitPullRequestDraft aria-hidden className="size-3.5 text-white" /> : <GitPullRequest aria-hidden className="size-3.5 text-white" />}
                    <Chip.Label className="!text-white">{pullRequestChip.label}</Chip.Label>
                  </Chip>
                </a>
              ) : (
                <Chip className={pullRequestChip.className} color={pullRequestChip.color} size="md" variant="primary">
                  {pullRequestChip.icon === 'merged' ? <GitMerge aria-hidden className="size-3.5 text-white" /> : pullRequestChip.icon === 'draft' ? <GitPullRequestDraft aria-hidden className="size-3.5 text-white" /> : <GitPullRequest aria-hidden className="size-3.5 text-white" />}
                  <Chip.Label className="!text-white">{pullRequestChip.label}</Chip.Label>
                </Chip>
              )
            ) : null}
            {task.issue.labels.length ? (
              <span className="flex shrink-0 items-center gap-1.5">
                {task.issue.labels.map((label) => (
                  <IssueLabelChip className="h-7 px-2.5 text-xs" key={label} label={label} />
                ))}
              </span>
            ) : null}
          </div>
        </div>
        <div className="relative mt-5 max-w-3xl">
          <div className={descriptionExpanded || !hasLongDescription ? '' : 'max-h-36 overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]'}>
            <IssueMarkdown className="text-sm leading-6 text-current/65" markdown={task.issue.body} repositoryFullName={repositoryFullName} />
          </div>
          {hasLongDescription ? (
            <button className="relative mt-2 inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-current/45 hover:bg-current/[.05] hover:text-current/75" onClick={() => setDescriptionExpanded((value) => !value)} type="button">
              {descriptionExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              {descriptionExpanded ? 'Show less' : 'Read full description'}
            </button>
          ) : null}
        </div>
        {parentIssue ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-current/50">
            <span className="rounded-full bg-current/[.05] px-2.5 py-1">
              Sub-task of #{parentIssue.number}
            </span>
          </div>
        ) : null}
        {task.workflowMessage ? (
          <p className="mt-4 text-sm leading-6 text-amber-300">{task.workflowMessage}</p>
        ) : null}
        <SubIssueList onOpenTask={onOpenTask} subIssueProgress={subIssueProgress} subIssues={subIssues} />
      </header>

      <ProjectTaskDetailTabs
        discussion={(
          <div className="pb-24 pt-2 md:pb-5">
            {isLoadingComments ? <p className="py-4 text-sm text-current/35">Loading conversation…</p> : <CommentTimeline comments={comments} repositoryFullName={repositoryFullName} />}
            {commentError ? <p className="mt-2 px-1 text-xs text-red-300">{commentError}</p> : null}
            <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-neutral-950/90 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl md:static md:border-0 md:bg-transparent md:p-0 md:pt-3 md:backdrop-blur-none">
              <div className="flex items-center gap-2 rounded-full bg-current/[.06] p-1.5 pl-4">
                <textarea aria-label="Add a GitHub comment" className="min-h-6 min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-1 text-sm leading-5 outline-none" onChange={(event) => setCommentBody(event.target.value)} rows={1} value={commentBody} />
                <Button aria-label={isPosting ? 'Posting comment' : 'Send comment'} className="!size-10 shrink-0 !rounded-full" isDisabled={!commentBody.trim() || isPosting} isIconOnly size="sm" variant="primary" onPress={submitComment}>
                  <Send className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
        pipeline={(
          <ProjectTaskPipelinePanel
            health={task.health}
            issueNumber={task.issue.number}
            pipeline={task.pipeline}
            projectId={project.id}
            pullRequest={task.pullRequest}
            repositoryFullName={repositoryFullName}
          />
        )}
        resetKey={task.issue.number}
        runner={(
          <ProjectTaskRunnerPanel
            issueNumber={task.issue.number}
            onNewTask={onNewCodexTask}
            onOpenTask={onOpenCodex}
            project={project}
          />
        )}
      />
    </section>
  );
}
