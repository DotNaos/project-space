import { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  GitBranch,
  GitBranchPlus,
  MessageSquare,
  Monitor,
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
  ConnectorOverviewResult,
  GitHubBranchRecord,
  GitHubIssueCommentRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import {
  canRunMachineCommand,
  cloneUrl,
  createStartDevelopmentCommand,
  getIssueMachineRows,
  machineStatusClass,
  relativeClonePath,
  repositoryNameFromProject,
  type IssueMachineProjectRow
} from './issue-development-machine-actions';
import {
  branchNameForIssue,
  issueBranchesForIssue
} from './issue-branch-model';
import { IssueMarkdown } from './issue-markdown';
import { connectorLocationPresentation } from './machine-connector-topology-model';

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
  repoFullName,
  repoUrl,
  targetPath
}: IssueActionPanelProps) {
  const defaultBranch = branches.find((branch) => branch.isDefault)?.name ?? 'main';
  const suggestedBranch = branchNameForIssue(issue);
  const [branchName, setBranchName] = useState(suggestedBranch);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [branchMessage, setBranchMessage] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isCreatingPullRequest, setIsCreatingPullRequest] = useState(false);
  const [pullRequestMessage, setPullRequestMessage] = useState('');
  const [pullRequestError, setPullRequestError] = useState('');
  const [busyMachineId, setBusyMachineId] = useState('');
  const [machineMessage, setMachineMessage] = useState('');
  const [isUpdatingState, setIsUpdatingState] = useState(false);
  const [stateError, setStateError] = useState('');
  const [comments, setComments] = useState<GitHubIssueCommentRecord[]>([]);
  const [commentsError, setCommentsError] = useState('');
  const [isLoadingComments, setIsLoadingComments] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const [isPostingComment, setIsPostingComment] = useState(false);

  useEffect(() => {
    setBranchName(suggestedBranch);
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

  const linkedBranches = useMemo(
    () => issueBranchesForIssue({ branches, issue }),
    [branches, issue]
  );
  const selectedBranch = linkedBranches[0];
  const visibleBranches = useMemo(
    () =>
      branches
        .filter((branch) => !branch.isDefault)
        .filter((branch) => !branch.linkedIssueNumbers?.includes(issue.number))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 6),
    [branches, issue.number]
  );

  const machineRows = useMemo<IssueMachineProjectRow[]>(
    () =>
      getIssueMachineRows({
        connectorOverview,
        project,
        projects,
        repoFullName
      }),
    [connectorOverview, project, projects, repoFullName]
  );

  const repositoryCloneUrl = cloneUrl(repoFullName, repoUrl);
  const repositoryName = repositoryNameFromProject(project, repoFullName);
  const fallbackRelativePath = relativeClonePath(targetPath || project.rootPath, repositoryName);

  async function createBranch(branchNameOverride?: string) {
    if (!repoFullName) {
      setBranchError('No GitHub repository is linked.');
      return;
    }

    const trimmedBranchName = (branchNameOverride ?? branchName).trim();

    if (!trimmedBranchName) {
      setBranchError('Branch name is required.');
      return;
    }

    const existingBranch = branches.find((branch) => branch.name === trimmedBranchName);

    setIsCreatingBranch(true);
    setBranchError('');
    setBranchMessage('');
    try {
      const result = await projectSpaceClient.createGitHubBranch({
        fullName: repoFullName,
        issueNumber: issue.number,
        name: trimmedBranchName,
        sourceBranch: existingBranch?.name ?? defaultBranch
      });

      if (result.status !== 'connected' || !result.branch) {
        setBranchError(result.message ?? 'Could not create branch.');
        return;
      }

      onBranchCreated(result.branch);
      setShowBranchPicker(false);
      setBranchMessage('Linked branch created.');
    } finally {
      setIsCreatingBranch(false);
    }
  }

  async function startDevelopment(row: IssueMachineProjectRow) {
    if (!selectedBranch) {
      setMachineMessage('Link a branch first.');
      return;
    }

    if (!canRunMachineCommand(row.machine)) {
      setMachineMessage(`${row.machine?.name ?? row.machineId} is not online.`);
      return;
    }

    if (!row.project && !repositoryCloneUrl) {
      setMachineMessage('No clone URL is available for this repository.');
      return;
    }

    setBusyMachineId(row.machineId);
    setMachineMessage('');
    try {
      const result = await projectSpaceClient.runMachineTerminalCommand({
        command: createStartDevelopmentCommand({
          branchName: selectedBranch.name,
          projectPath: row.project?.rootPath,
          relativePath: fallbackRelativePath,
          repository: repositoryCloneUrl
        }),
        machineId: row.machineId
      });

      setMachineMessage(
        result.exitCode === 0
          ? result.stdout.trim() || `Started ${selectedBranch.name} on ${row.machine?.name ?? row.machineId}.`
          : result.stderr || result.stdout || `Could not start development on ${row.machine?.name ?? row.machineId}.`
      );
    } finally {
      setBusyMachineId('');
    }
  }

  async function createPullRequest() {
    if (!repoFullName || !selectedBranch) {
      setPullRequestError('Link a branch first.');
      return;
    }

    setIsCreatingPullRequest(true);
    setPullRequestError('');
    setPullRequestMessage('');
    try {
      const result = await projectSpaceClient.createGitHubPullRequest({
        baseBranch: defaultBranch,
        body: issue.body,
        fullName: repoFullName,
        headBranch: selectedBranch.name,
        issueNumber: issue.number,
        title: issue.title
      });

      if (result.status !== 'connected' || !result.pullRequest) {
        setPullRequestError(result.message ?? 'Could not create pull request.');
        return;
      }

      onPullRequestCreated(result.pullRequest);
      setPullRequestMessage(`Pull request #${result.pullRequest.number} created.`);
    } finally {
      setIsCreatingPullRequest(false);
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
          <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-[11px] text-neutral-400">
                1
              </span>
              <Text className="min-w-0 flex-1 text-xs font-medium text-neutral-300">
                Branch
              </Text>
              {selectedBranch ? <CheckCircle2 className="size-3.5 text-emerald-300" /> : null}
            </div>
            {selectedBranch ? (
              <div className="flex min-w-0 items-center gap-2 rounded-md bg-neutral-900/70 px-2 py-1.5">
                <GitBranch className="size-3.5 shrink-0 text-neutral-500" />
                <Text className="min-w-0 flex-1 truncate font-mono text-xs text-neutral-200">
                  {selectedBranch.name}
                </Text>
              </div>
            ) : (
              <Text className="text-xs text-neutral-500">No branch linked yet.</Text>
            )}
            <Button
              size="sm"
              variant="ghost"
              isDisabled={Boolean(selectedBranch)}
              className="justify-start"
              onPress={() => setShowBranchPicker((value) => !value)}
            >
              <GitBranchPlus className="size-4" />
              Create linked branch
            </Button>
          </div>
          {showBranchPicker ? (
            <div className="issue-rise-in grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
              {visibleBranches.length > 0 ? (
                <div className="grid gap-1">
                  <Text className="text-xs text-neutral-500">Existing branches</Text>
                  {visibleBranches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      onClick={() => {
                        setBranchName(branch.name);
                        void createBranch(branch.name);
                      }}
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-50"
                    >
                      <GitBranch className="size-3 shrink-0 text-neutral-500" />
                      <span className="min-w-0 truncate font-mono">{branch.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
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
                {isCreatingBranch ? 'Creating...' : 'Create linked branch'}
              </Button>
              <Text className="text-xs text-neutral-600">
                Existing branches only appear here after GitHub links them to this issue.
              </Text>
              {branchMessage ? <Text className="text-xs text-emerald-300">{branchMessage}</Text> : null}
              {branchError ? <Text className="text-xs text-red-300">{branchError}</Text> : null}
            </div>
          ) : null}
          <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-[11px] text-neutral-400">
                2
              </span>
              <Text className="min-w-0 flex-1 text-xs font-medium text-neutral-300">
                Next action
              </Text>
            </div>
            <Button
              variant="secondary"
              isDisabled={!selectedBranch || !repoFullName || isCreatingPullRequest}
              onPress={() => void createPullRequest()}
            >
              <Rocket className="size-4" />
              {isCreatingPullRequest ? 'Creating PR...' : 'Create PR'}
            </Button>
            {pullRequestMessage ? (
              <Text className="text-xs text-emerald-300">{pullRequestMessage}</Text>
            ) : null}
            {pullRequestError ? (
              <Text className="text-xs text-red-300">{pullRequestError}</Text>
            ) : null}
          </div>
          <div className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 p-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-[11px] text-neutral-400">
                3
              </span>
              <Text className="min-w-0 flex-1 text-xs font-medium text-neutral-300">
                Start development
              </Text>
            </div>
            {machineRows.length > 0 ? (
              <div className="grid gap-1">
                {machineRows.map((row) => {
                  const hasCheckout = Boolean(row.project);
                  const location = row.machine ? connectorLocationPresentation({
                    connector: row.machine,
                    physicalMachines: connectorOverview.physicalMachines ?? []
                  }) : undefined;
                  const canStart =
                    Boolean(selectedBranch) &&
                    canRunMachineCommand(row.machine) &&
                    (hasCheckout || Boolean(repositoryCloneUrl));

                  return (
                    <button
                      key={row.machineId}
                      type="button"
                      disabled={!canStart || busyMachineId === row.machineId}
                      onClick={() => void startDevelopment(row)}
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-50 disabled:pointer-events-none disabled:opacity-45"
                    >
                      {hasCheckout ? (
                        <Monitor className="size-3.5 shrink-0 text-neutral-500" />
                      ) : (
                        <Download className="size-3.5 shrink-0 text-neutral-500" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {busyMachineId === row.machineId
                            ? 'Starting...'
                            : location?.machineName ?? row.machineId}
                        </span>
                        {location && busyMachineId !== row.machineId ? (
                          <span className="block truncate text-[11px] text-neutral-500">
                            {location.connectorLabel}
                          </span>
                        ) : null}
                      </span>
                      <span className={machineStatusClass(row.machine?.connector.status)}>
                        {hasCheckout ? 'open' : 'clone'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <Text className="text-xs text-neutral-500">No connector installations registered.</Text>
            )}
            {machineMessage ? <Text className="text-xs text-neutral-500">{machineMessage}</Text> : null}
          </div>
          <Button variant="ghost" isDisabled>
            <Play className="size-4" />
            Run tests
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
