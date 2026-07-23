import { useEffect, useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import type {
  ConnectorOverviewResult,
  GitHubBranchRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { IssueDevelopmentSession } from './issue-development-session';
import { IssueMarkdown } from './issue-markdown';

function commentTimeLabel(comment: GitHubIssueCommentRecord) {
  const value = comment.updatedAt || comment.createdAt;
  return value ? new Date(value).toLocaleString() : 'unknown';
}

interface IssueActionPanelProps {
  branches: GitHubBranchRecord[];
  connectorOverview: ConnectorOverviewResult;
  issue: GitHubIssueRecord;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onIssueUpdated(issue: GitHubIssueRecord): void;
  onPullRequestCreated(pullRequest: GitHubPullRequestRecord): void;
  project: ProjectSpaceRecord;
  projects: ProjectSpaceRecord[];
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
  repoUrl?: string;
  targetPath: string;
}

export function IssueActionPanel({
  branches,
  connectorOverview,
  issue,
  onBranchCreated,
  onIssueUpdated,
  onPullRequestCreated,
  project,
  projects,
  pullRequests,
  repoFullName,
  repoUrl,
  targetPath
}: IssueActionPanelProps) {
  const [isUpdatingState, setIsUpdatingState] = useState(false);
  const [stateError, setStateError] = useState('');
  const [comments, setComments] = useState<GitHubIssueCommentRecord[]>([]);
  const [commentsError, setCommentsError] = useState('');
  const [isLoadingComments, setIsLoadingComments] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [isPostingComment, setIsPostingComment] = useState(false);

  useEffect(() => {
    if (!repoFullName) {
      setComments([]);
      setCommentsError('');
      setIsLoadingComments(false);
      return;
    }

    let canceled = false;
    setIsLoadingComments(true);
    setCommentsError('');
    projectSpaceClient
      .getGitHubIssueComments(repoFullName, issue.number)
      .then((result) => {
        if (canceled) return;
        if (result.status !== 'connected') {
          setComments([]);
          setCommentsError(result.message ?? 'Could not load comments.');
          return;
        }
        setComments(result.comments);
      })
      .catch((error) => {
        if (!canceled) {
          setCommentsError(error instanceof Error ? error.message : 'Could not load comments.');
        }
      })
      .finally(() => {
        if (!canceled) setIsLoadingComments(false);
      });

    return () => {
      canceled = true;
    };
  }, [issue.number, repoFullName]);

  async function updateIssueState(nextState: GitHubIssueRecord['state']) {
    if (!repoFullName || nextState === issue.state) return;
    setIsUpdatingState(true);
    setStateError('');
    try {
      const result = await projectSpaceClient.updateGitHubIssue({
        fullName: repoFullName,
        number: issue.number,
        state: nextState
      });
      if (result.status !== 'connected' || !result.issue) {
        setStateError(result.message ?? 'Could not update issue state.');
        return;
      }
      onIssueUpdated(result.issue);
    } finally {
      setIsUpdatingState(false);
    }
  }

  async function postComment() {
    if (!repoFullName) {
      setCommentsError('No GitHub repository is linked.');
      return;
    }
    const body = commentBody.trim();
    if (!body) return;

    setIsPostingComment(true);
    setCommentsError('');
    try {
      const result = await projectSpaceClient.createGitHubIssueComment({
        body,
        fullName: repoFullName,
        number: issue.number
      });
      if (result.status !== 'connected' || !result.comment) {
        setCommentsError(result.message ?? 'Could not post comment.');
        return;
      }
      setComments((previous) => [...previous, result.comment as GitHubIssueCommentRecord]);
      setCommentBody('');
    } finally {
      setIsPostingComment(false);
    }
  }

  return (
    <aside className="grid min-w-0 content-start gap-3 overflow-x-hidden overflow-visible lg:overflow-y-auto">
      <IssueDevelopmentSession
        branches={branches}
        connectorOverview={connectorOverview}
        issue={issue}
        onBranchCreated={onBranchCreated}
        onPullRequestCreated={onPullRequestCreated}
        project={project}
        projects={projects}
        pullRequests={pullRequests}
        repoFullName={repoFullName}
        repoUrl={repoUrl}
        targetPath={targetPath}
      />

      <Surface variant="tertiary" className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
        <Text className="mb-2.5 block text-sm font-semibold text-neutral-100">Details</Text>
        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">State</Text>
            <Text className="text-neutral-200">{issue.state}</Text>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-1">
            <Button size="sm" variant={issue.state === 'open' ? 'secondary' : 'ghost'} className="h-7 min-w-0 text-xs" isDisabled={isUpdatingState || !repoFullName || issue.state === 'open'} onPress={() => void updateIssueState('open')}>
              Open
            </Button>
            <Button size="sm" variant={issue.state === 'closed' ? 'secondary' : 'ghost'} className="h-7 min-w-0 text-xs" isDisabled={isUpdatingState || !repoFullName || issue.state === 'closed'} onPress={() => void updateIssueState('closed')}>
              Closed
            </Button>
          </div>
          {stateError ? <Text className="text-xs text-red-300">{stateError}</Text> : null}
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Author</Text>
            <Text className="truncate text-neutral-200">{issue.author ?? 'unknown'}</Text>
          </div>
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Updated</Text>
            <Text className="truncate font-mono text-xs text-neutral-300">
              {issue.updatedAt ? new Date(issue.updatedAt).toLocaleDateString() : 'unknown'}
            </Text>
          </div>
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">Labels</Text>
            <Text className="font-mono text-xs tabular-nums text-neutral-300">{issue.labels.length}</Text>
          </div>
        </div>
      </Surface>

      <Surface variant="tertiary" className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
        <div className="mb-2.5 flex items-center gap-2">
          <MessageSquare className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Comments</Text>
          <Text className="ml-auto font-mono text-xs text-neutral-500">{comments.length}</Text>
        </div>
        <div className="grid max-h-64 gap-2 overflow-y-auto pr-1">
          {isLoadingComments ? (
            <Text className="text-sm text-neutral-500">Loading comments...</Text>
          ) : comments.length > 0 ? (
            comments.map((comment) => (
              <div key={comment.id} className="rounded-lg border border-neutral-800 bg-black/20 p-2">
                <div className="mb-1 flex min-w-0 items-center gap-2">
                  <Text className="truncate text-xs font-medium text-neutral-300">{comment.author ?? 'unknown'}</Text>
                  <Text className="ml-auto shrink-0 text-[10px] text-neutral-600">{commentTimeLabel(comment)}</Text>
                </div>
                <div className="[&_*]:break-words [&_code]:break-all">
                  <IssueMarkdown markdown={comment.body} />
                </div>
              </div>
            ))
          ) : (
            <Text className="text-sm text-neutral-500">No comments yet.</Text>
          )}
        </div>
        <textarea value={commentBody} onChange={(event) => setCommentBody(event.currentTarget.value)} placeholder="Add a comment" rows={3} className="mt-3 min-h-20 w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm leading-5 text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600" />
        {commentsError ? <Text className="mt-2 block text-xs text-red-300">{commentsError}</Text> : null}
        <Button size="sm" className="mt-2 w-full" isDisabled={isPostingComment || !commentBody.trim() || !repoFullName} onPress={() => void postComment()}>
          <Send className="size-4" />{isPostingComment ? 'Posting...' : 'Post comment'}
        </Button>
      </Surface>
    </aside>
  );
}
