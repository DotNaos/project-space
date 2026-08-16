import { useState } from 'react';
import { Avatar, Button, Chip } from '@heroui/react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  CircleDashed,
  CircleDot,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Send
} from 'lucide-react';
import type {
  GitHubIssueCommentRecord
} from '@/shared/project-space-api';
import { IssueMarkdown } from '@/features/project-desktop/components/issue-markdown';
import { IssueLabelChip } from '@/features/project-desktop/components/issue-visuals';
import { useRuntimeBinding } from '@/features/project-desktop/components/runtime-binding-context';
import { ProjectTaskDetailTabs } from './project-task-detail-tabs';
import { pullRequestChipPresentation } from './project-task-presentation';
import type { ProjectTaskViewModel } from './task-view-model';

function taskStateLabel(task: ProjectTaskViewModel) {
  if (task.health === 'attention' || task.workflowMessage) return 'Needs attention';
  if (task.state === 'completed') return 'Completed';
  if (task.state === 'review') return 'Review';
  if (task.state === 'active') return 'Active';
  return 'Backlog';
}

function WorkspaceRuntimeNotice() {
  return (
    <section className="grid gap-3 rounded-xl border border-current/[.08] bg-current/[.025] p-5">
      <div>
        <h2 className="text-sm font-semibold text-current/85">Workspace Runtime</h2>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-current/55">
          Task execution and pipeline actions are available through the canonical Compute view.
          Open Compute to inspect the available runtime before continuing.
        </p>
      </div>
      <a className="inline-flex w-fit" href="/settings">
        <Button size="sm" variant="secondary">Open Compute</Button>
      </a>
    </section>
  );
}

function TaskStateChipIcon({ task }: { task: ProjectTaskViewModel }) {
  const className = 'size-3.5 shrink-0 text-white';
  if (task.health === 'attention' || task.workflowMessage) {
    return <CircleX aria-hidden className={className} />;
  }
  if (task.state === 'completed') return <GitMerge aria-hidden className={className} />;
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
  if (task.state === 'review') return { color: 'success' };
  if (task.state === 'active') return { color: 'accent' };
  return { className: '!bg-neutral-600', color: 'default' };
}

function SubIssueList({ onOpenTask, subIssues }: {
  onOpenTask(issueNumber: number): void;
  subIssues: ProjectTaskViewModel[];
}) {
  if (subIssues.length === 0) return null;

  return (
    <section className="mt-7 border-t border-current/[.08] pt-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-current/85">Sub-issues</h2>
          <p className="mt-1 text-xs text-current/40">Work grouped under this issue</p>
        </div>
        <span className="rounded-full bg-current/[.05] px-2.5 py-1 text-xs tabular-nums text-current/50">
          {subIssues.length}
        </span>
      </div>
      <ul aria-label="Sub-issues" className="mt-3 divide-y divide-current/[.07]">
        {subIssues.map((subIssue) => (
          <li key={subIssue.issue.number}>
            <button
              aria-label={`Open sub-issue #${subIssue.issue.number}: ${subIssue.issue.title}`}
              className="group flex min-h-12 w-full items-center gap-3 py-2 text-left transition-colors hover:text-current"
              onClick={() => onOpenTask(subIssue.issue.number)}
              type="button"
            >
              <span className="shrink-0 text-xs tabular-nums text-current/30">#{subIssue.issue.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-current/70 group-hover:text-current/90">
                {subIssue.issue.title}
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-current/45">
                <TaskStateChipIcon task={subIssue} />
                {taskStateLabel(subIssue)}
              </span>
            </button>
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
  onOpenTask,
  repositoryFullName,
  subIssues,
  task
}: {
  addComment(body: string): Promise<void>;
  comments: GitHubIssueCommentRecord[];
  isLoadingComments: boolean;
  onBack(): void;
  onOpenTask(issueNumber: number): void;
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
          {runtime.apis === 'external' && task.issue.url ? (
            <a aria-label="Open issue on GitHub" className="rounded-full p-2 text-current/35 hover:bg-current/[.06] hover:text-current" href={task.issue.url} rel="noreferrer" target="_blank">
              <ExternalLink className="size-4" />
            </a>
          ) : <span aria-hidden="true" className="size-8" />}
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
        {parentIssue || subIssueProgress ? (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-current/50">
            {parentIssue ? (
              <span className="rounded-full bg-current/[.05] px-2.5 py-1">
                Sub-issue of #{parentIssue.number}
              </span>
            ) : null}
            {subIssueProgress ? (
              <span className="rounded-full bg-current/[.05] px-2.5 py-1 tabular-nums">
                Sub-issues {subIssueProgress.completed}/{subIssueProgress.total} complete
              </span>
            ) : null}
          </div>
        ) : null}
        {task.workflowMessage ? (
          <p className="mt-4 text-sm leading-6 text-amber-300">{task.workflowMessage}</p>
        ) : null}
        <SubIssueList onOpenTask={onOpenTask} subIssues={subIssues} />
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
          <WorkspaceRuntimeNotice />
        )}
        resetKey={task.issue.number}
        runner={(
          <div className="py-5"><WorkspaceRuntimeNotice /></div>
        )}
      />
    </section>
  );
}
