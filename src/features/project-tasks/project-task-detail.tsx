import { useState } from 'react';
import { Button } from '@heroui/react';
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
  MessageCircle,
  Send
} from 'lucide-react';
import type {
  ConnectorOverviewResult,
  GitHubBranchRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { IssueDevelopmentSession } from '@/features/project-desktop/components/issue-development-session';
import { IssueMarkdown } from '@/features/project-desktop/components/issue-markdown';
import type { ProjectTaskViewModel } from './task-view-model';

function TaskStateIcon({ task }: { task: ProjectTaskViewModel }) {
  const className = 'mt-1 size-5 shrink-0';
  if (task.health === 'attention' || task.workflowMessage) return <CircleX aria-label="Needs attention" className={`${className} text-red-400`} />;
  if (task.state === 'completed') return <GitMerge aria-label="Completed" className={`${className} text-violet-400`} />;
  if (task.state === 'review') return <CircleDot aria-label="Review" className={`${className} text-emerald-400`} />;
  if (task.state === 'active') return <CircleDot aria-label="Active" className={`${className} text-blue-400`} />;
  return <CircleDashed aria-label="Backlog" className={`${className} text-neutral-600`} />;
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
          <div className="flex items-center justify-between gap-3 text-xs text-current/40">
            <span className="font-medium text-current/65">{comment.author ?? 'GitHub user'}</span>
            <time>{comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : ''}</time>
          </div>
          <IssueMarkdown className="mt-2 text-sm leading-6 text-current/75" markdown={comment.body} repositoryFullName={repositoryFullName} />
        </article>
      ))}
    </div>
  );
}

export function ProjectTaskDetail({
  addComment,
  branches,
  comments,
  connectorOverview,
  isLoadingComments,
  onBack,
  onBranchCreated,
  onIssueUpdated,
  onOpenHistory,
  onPullRequestCreated,
  project,
  projects,
  pullRequests,
  repositoryFullName,
  repositoryUrl,
  targetPath,
  task
}: {
  addComment(body: string): Promise<void>;
  branches: GitHubBranchRecord[];
  comments: GitHubIssueCommentRecord[];
  connectorOverview: ConnectorOverviewResult;
  isLoadingComments: boolean;
  onBack(): void;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onIssueUpdated(issue: GitHubIssueRecord): void;
  onOpenHistory(input: { defaultBranch: string; headBranch: string }): void;
  onPullRequestCreated(pullRequest: GitHubPullRequestRecord): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  pullRequests: GitHubPullRequestRecord[];
  repositoryFullName?: string;
  repositoryUrl?: string;
  targetPath: string;
  task: ProjectTaskViewModel;
}) {
  const [commentBody, setCommentBody] = useState('');
  const [commentError, setCommentError] = useState('');
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const [isPosting, setIsPosting] = useState(false);
  const pullRequest = task.pullRequest;
  const pipeline = task.pipeline;
  const hasLongDescription = (task.issue.body?.length ?? 0) > 420;

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
          <a aria-label="Open issue on GitHub" className="rounded-full p-2 text-current/35 hover:bg-current/[.06] hover:text-current" href={task.issue.url} rel="noreferrer" target="_blank">
            <ExternalLink className="size-4" />
          </a>
        </div>
        <div className="mt-4 flex min-w-0 items-start gap-3">
          <TaskStateIcon task={task} />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold leading-tight tracking-[-.035em] @lg:text-3xl">{task.issue.title}</h1>
            <p className="mt-2 text-sm tabular-nums text-current/30">#{task.issue.number}</p>
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
        {task.issue.labels.length ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {task.issue.labels.map((label) => <span className="rounded-full bg-current/[.045] px-2.5 py-1 text-[11px] text-current/35" key={label}>{label}</span>)}
          </div>
        ) : null}
        {task.workflowMessage ? (
          <p className="mt-4 text-sm leading-6 text-amber-300">{task.workflowMessage}</p>
        ) : null}
      </header>

      <div>
        <section className="grid gap-px border-b border-current/[.08] py-4 @lg:grid-cols-2">
          <a className="flex min-h-12 items-center gap-3 rounded-xl px-2 text-sm hover:bg-current/[.045]" href={pullRequest?.url ?? task.issue.url} rel="noreferrer" target="_blank">
            {pullRequest?.state === 'merged' ? <GitMerge className="size-4 text-violet-400" /> : <GitPullRequest className="size-4 text-current/35" />}
            <span className="text-current/45">Pull request</span>
            <span className={`ml-auto font-medium ${pullRequest?.state === 'merged' ? 'text-violet-300' : 'text-current/80'}`}>
              {pullRequest ? `${pullRequest.isDraft ? 'Draft ' : pullRequest.state === 'merged' ? 'Merged ' : ''}#${pullRequest.number}` : 'Not started'}
            </span>
            <ExternalLink className="size-3 text-current/25" />
          </a>
          <a className={`flex min-h-12 items-center gap-3 rounded-xl px-2 text-sm ${pipeline?.url ? 'hover:bg-current/[.045]' : 'pointer-events-none'}`} href={pipeline?.url} rel="noreferrer" target="_blank">
            <CircleDot className={`size-4 ${task.health === 'attention' ? 'text-red-400' : task.health === 'healthy' ? 'text-emerald-400' : 'text-current/25'}`} />
            <span className="text-current/45">Pipeline</span>
            <span className={`ml-auto font-medium ${task.health === 'attention' ? 'text-red-300' : task.health === 'healthy' ? 'text-emerald-300' : 'text-current/35'}`}>
              {task.health === 'attention'
                ? 'Checks failed'
                : task.health === 'healthy'
                  ? 'Checks passed'
                  : pipeline?.status ?? (pullRequest ? 'No status' : 'Not started')}
            </span>
          </a>
        </section>

        <section className="border-b border-current/[.08] py-5">
          <IssueDevelopmentSession
            branches={branches}
            connectorOverview={connectorOverview}
            issue={task.issue}
            onBranchCreated={onBranchCreated}
            onOpenHistory={onOpenHistory}
            onPullRequestCreated={onPullRequestCreated}
            project={project}
            projects={projects}
            pullRequests={pullRequests}
            repoFullName={repositoryFullName}
            repoUrl={repositoryUrl}
            targetPath={targetPath}
          />
        </section>

        <section className="py-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><MessageCircle className="size-4 text-current/45" /> Discussion <span className="font-normal text-current/30">{comments.length}</span></h2>
          {isLoadingComments ? <p className="py-4 text-sm text-current/35">Loading conversation…</p> : <CommentTimeline comments={comments} repositoryFullName={repositoryFullName} />}
          <div className="mt-3 overflow-hidden rounded-2xl bg-current/[.045] p-2">
            <textarea aria-label="Add a GitHub comment" className="min-h-28 w-full resize-y bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-current/25" onChange={(event) => setCommentBody(event.target.value)} placeholder="Add a comment with Markdown" value={commentBody} />
            <div className="flex items-center justify-between gap-3 px-1 pb-1">
              <p className="text-xs text-red-300">{commentError}</p>
              <Button isDisabled={!commentBody.trim() || isPosting} size="sm" variant="primary" onPress={submitComment}><Send className="size-3.5" /> {isPosting ? 'Posting…' : 'Comment'}</Button>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
