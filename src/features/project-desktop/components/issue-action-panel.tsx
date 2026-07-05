import { useEffect, useMemo, useState } from 'react';
import {
  ExternalLink,
  GitBranch,
  GitBranchPlus,
  MessageSquare,
  Play,
  Rocket,
  Send
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Button,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import type {
  GitHubBranchRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord
} from '@/shared/project-space-api';
import { IssueMarkdown } from './issue-markdown';

function branchNameForIssue(issue: GitHubIssueRecord) {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  return `issue-${issue.number}${slug ? `-${slug}` : ''}`;
}

function issueBranchScore(issue: GitHubIssueRecord, branch: GitHubBranchRecord) {
  const normalizedBranch = branch.name.toLowerCase();
  const titleWords = issue.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  let score = 0;

  if (normalizedBranch.includes(String(issue.number))) {
    score += 10;
  }
  for (const word of titleWords) {
    if (normalizedBranch.includes(word)) {
      score += 1;
    }
  }

  return score;
}

function branchWebUrl(repoUrl: string | undefined, branchName: string) {
  return repoUrl
    ? `${repoUrl}/tree/${encodeURIComponent(branchName).replace(/%2F/g, '/')}`
    : undefined;
}

function pullRequestUrl(repoUrl: string | undefined, baseBranch: string, branchName: string) {
  return repoUrl
    ? `${repoUrl}/compare/${encodeURIComponent(baseBranch).replace(/%2F/g, '/')}...${encodeURIComponent(branchName).replace(/%2F/g, '/')}?quick_pull=1`
    : undefined;
}

function commentTimeLabel(comment: GitHubIssueCommentRecord) {
  const value = comment.updatedAt || comment.createdAt;

  return value ? new Date(value).toLocaleString() : 'unknown';
}

interface IssueActionPanelProps {
  branches: GitHubBranchRecord[];
  issue: GitHubIssueRecord;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onIssueUpdated(issue: GitHubIssueRecord): void;
  repoFullName?: string;
  repoUrl?: string;
}

export function IssueActionPanel({
  branches,
  issue,
  onBranchCreated,
  onIssueUpdated,
  repoFullName,
  repoUrl
}: IssueActionPanelProps) {
  const defaultBranch = branches.find((branch) => branch.isDefault)?.name ?? 'main';
  const suggestedBranch = branchNameForIssue(issue);
  const [branchName, setBranchName] = useState(suggestedBranch);
  const [selectedBranch, setSelectedBranch] = useState<GitHubBranchRecord | undefined>();
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [branchMessage, setBranchMessage] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isUpdatingState, setIsUpdatingState] = useState(false);
  const [stateError, setStateError] = useState('');
  const [comments, setComments] = useState<GitHubIssueCommentRecord[]>([]);
  const [commentsError, setCommentsError] = useState('');
  const [isLoadingComments, setIsLoadingComments] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [isPostingComment, setIsPostingComment] = useState(false);

  useEffect(() => {
    setBranchName(suggestedBranch);
    setSelectedBranch(undefined);
    setBranchError('');
    setBranchMessage('');
  }, [issue.number, suggestedBranch]);

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
        if (canceled) {
          return;
        }
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
        if (!canceled) {
          setIsLoadingComments(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, [issue.number, repoFullName]);

  const visibleBranches = useMemo(() => {
    const scoredBranches = branches
      .map((branch) => ({ branch, score: issueBranchScore(issue, branch) }))
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (left.branch.isDefault !== right.branch.isDefault) {
          return left.branch.isDefault ? 1 : -1;
        }
        return left.branch.name.localeCompare(right.branch.name);
      });
    const relevant = scoredBranches.filter((entry) => entry.score > 0).map((entry) => entry.branch);

    return relevant.length > 0
      ? relevant.slice(0, 6)
      : scoredBranches.map((entry) => entry.branch).slice(0, 6);
  }, [branches, issue]);

  const selectedBranchUrl = selectedBranch ? branchWebUrl(repoUrl, selectedBranch.name) : undefined;
  const selectedPullRequestUrl = selectedBranch
    ? pullRequestUrl(repoUrl, defaultBranch, selectedBranch.name)
    : undefined;

  async function createBranch() {
    if (!repoFullName) {
      setBranchError('No GitHub repository is linked.');
      return;
    }

    const trimmedBranchName = branchName.trim();

    if (!trimmedBranchName) {
      setBranchError('Branch name is required.');
      return;
    }

    const existingBranch = branches.find((branch) => branch.name === trimmedBranchName);

    if (existingBranch) {
      setSelectedBranch(existingBranch);
      setBranchMessage('Using existing branch.');
      setBranchError('');
      return;
    }

    setIsCreatingBranch(true);
    setBranchError('');
    setBranchMessage('');
    try {
      const result = await projectSpaceClient.createGitHubBranch({
        fullName: repoFullName,
        name: trimmedBranchName,
        sourceBranch: defaultBranch
      });

      if (result.status !== 'connected' || !result.branch) {
        setBranchError(result.message ?? 'Could not create branch.');
        return;
      }

      onBranchCreated(result.branch);
      setSelectedBranch(result.branch);
      setBranchMessage('Branch created.');
    } finally {
      setIsCreatingBranch(false);
    }
  }

  async function updateIssueState(nextState: GitHubIssueRecord['state']) {
    if (!repoFullName || nextState === issue.state) {
      return;
    }

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

    if (!body) {
      return;
    }

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
    <aside className="grid min-w-0 content-start gap-3 overflow-x-hidden overflow-y-auto">
      <Surface variant="tertiary" className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
        <div className="mb-3 flex items-center gap-2">
          <Play className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Development session</Text>
        </div>
        <Text className="mb-3 block text-sm text-neutral-500">
          Start work from issue <span className="font-mono text-neutral-300">#{issue.number}</span>.
        </Text>
        <div className="grid gap-2">
          <Button variant="secondary" onPress={() => setShowBranchPicker((value) => !value)}>
            <GitBranchPlus className="size-4" />
            Start branch
          </Button>
          {showBranchPicker ? (
            <div className="issue-rise-in grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
              <label className="grid gap-1">
                <Text className="text-xs text-neutral-500">Branch name</Text>
                <input
                  value={branchName}
                  onChange={(event) => setBranchName(event.currentTarget.value)}
                  className="h-8 rounded-md border border-neutral-800 bg-neutral-950 px-2 font-mono text-xs text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
                />
              </label>
              <Button
                size="sm"
                isDisabled={isCreatingBranch || !repoFullName || !branchName.trim()}
                onPress={() => void createBranch()}
              >
                <GitBranchPlus className="size-4" />
                {isCreatingBranch ? 'Creating...' : 'Create branch'}
              </Button>
              {visibleBranches.length > 0 ? (
                <div className="grid gap-1">
                  <Text className="text-xs text-neutral-500">Existing branches</Text>
                  {visibleBranches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      onClick={() => {
                        setSelectedBranch(branch);
                        setBranchName(branch.name);
                        setBranchError('');
                        setBranchMessage('Using existing branch.');
                      }}
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-50"
                    >
                      <GitBranch className="size-3 shrink-0 text-neutral-500" />
                      <span className="min-w-0 truncate font-mono">{branch.name}</span>
                      {branch.isDefault ? (
                        <span className="ml-auto shrink-0 text-[10px] text-neutral-600">default</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
              {selectedBranch ? (
                <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1.5">
                  <Text className="block truncate font-mono text-xs text-emerald-200">
                    {selectedBranch.name}
                  </Text>
                  {selectedBranchUrl ? (
                    <a
                      href={selectedBranchUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-300/80 transition hover:text-emerald-100"
                    >
                      Open branch
                      <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                </div>
              ) : null}
              {branchMessage ? <Text className="text-xs text-emerald-300">{branchMessage}</Text> : null}
              {branchError ? <Text className="text-xs text-red-300">{branchError}</Text> : null}
            </div>
          ) : null}
          <Button variant="ghost" isDisabled>
            <Play className="size-4" />
            Run tests
          </Button>
          <Button
            variant="ghost"
            isDisabled={!selectedPullRequestUrl}
            onPress={() => {
              if (selectedPullRequestUrl) {
                window.open(selectedPullRequestUrl, '_blank', 'noreferrer');
              }
            }}
          >
            <Rocket className="size-4" />
            Create PR
          </Button>
        </div>
      </Surface>

      <Surface variant="tertiary" className="rounded-xl border border-neutral-800/70 bg-neutral-950/40 p-3.5">
        <Text className="mb-2.5 block text-sm font-semibold text-neutral-100">Details</Text>
        <div className="grid gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <Text className="text-neutral-500">State</Text>
            <Text className="text-neutral-200">{issue.state}</Text>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-1">
            <Button
              size="sm"
              variant={issue.state === 'open' ? 'secondary' : 'ghost'}
              className="h-7 min-w-0 text-xs"
              isDisabled={isUpdatingState || !repoFullName || issue.state === 'open'}
              onPress={() => void updateIssueState('open')}
            >
              Open
            </Button>
            <Button
              size="sm"
              variant={issue.state === 'closed' ? 'secondary' : 'ghost'}
              className="h-7 min-w-0 text-xs"
              isDisabled={isUpdatingState || !repoFullName || issue.state === 'closed'}
              onPress={() => void updateIssueState('closed')}
            >
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
            <Text className="font-mono text-xs tabular-nums text-neutral-300">
              {issue.labels.length}
            </Text>
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
                  <Text className="truncate text-xs font-medium text-neutral-300">
                    {comment.author ?? 'unknown'}
                  </Text>
                  <Text className="ml-auto shrink-0 text-[10px] text-neutral-600">
                    {commentTimeLabel(comment)}
                  </Text>
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
        <textarea
          value={commentBody}
          onChange={(event) => setCommentBody(event.currentTarget.value)}
          placeholder="Add a comment"
          rows={3}
          className="mt-3 min-h-20 w-full resize-y rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm leading-5 text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
        />
        {commentsError ? <Text className="mt-2 block text-xs text-red-300">{commentsError}</Text> : null}
        <Button
          size="sm"
          className="mt-2 w-full"
          isDisabled={isPostingComment || !commentBody.trim() || !repoFullName}
          onPress={() => void postComment()}
        >
          <Send className="size-4" />
          {isPostingComment ? 'Posting...' : 'Post comment'}
        </Button>
      </Surface>
    </aside>
  );
}
