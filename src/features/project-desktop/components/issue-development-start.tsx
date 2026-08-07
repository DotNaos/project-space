import { useEffect, useState } from 'react';
import {
  Check,
  GitBranch,
  GitBranchPlus,
  GitPullRequestDraft,
  LoaderCircle,
  Plus
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import { branchNameForIssue } from './issue-branch-model';

interface IssueDevelopmentStartProps {
  canCreatePullRequest?: boolean;
  issue: GitHubIssueRecord;
  linkedBranch?: GitHubBranchRecord;
  onBranchReady(branch: GitHubBranchRecord): void;
  onPullRequestReady(pullRequest: GitHubPullRequestRecord): void;
  recoveryMessage?: string;
  repoFullName?: string;
}

export function IssueDevelopmentStart({
  canCreatePullRequest = false,
  issue,
  linkedBranch,
  onBranchReady,
  onPullRequestReady,
  recoveryMessage,
  repoFullName
}: IssueDevelopmentStartProps) {
  const suggestedBranch = branchNameForIssue(issue);
  const [branchName, setBranchName] = useState(suggestedBranch);
  const [showSetup, setShowSetup] = useState(Boolean(linkedBranch || recoveryMessage));
  const [isStarting, setIsStarting] = useState(false);
  const [hasReadyPullRequest, setHasReadyPullRequest] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const isBlockedRecovery = Boolean(recoveryMessage && !linkedBranch);

  useEffect(() => {
    setBranchName(linkedBranch?.name ?? suggestedBranch);
    setShowSetup(Boolean(linkedBranch || recoveryMessage));
  }, [linkedBranch?.name, recoveryMessage, suggestedBranch]);

  useEffect(() => {
    setMessage('');
    setError('');
    setHasReadyPullRequest(false);
  }, [issue.number]);

  async function startDevelopment() {
    if (!repoFullName) {
      setError('No GitHub repository is linked.');
      return;
    }
    const requestedBranch = (linkedBranch?.name ?? branchName).trim();
    if (!requestedBranch) {
      setError('Branch name is required.');
      return;
    }

    setIsStarting(true);
    setError('');
    setMessage('');
    try {
      const result = await projectSpaceClient.startGitHubIssueDevelopment({
        branchName: requestedBranch,
        fullName: repoFullName,
        issueNumber: issue.number
      });
      if (result.state !== 'blocked') onBranchReady(result.branch);
      if (result.state === 'ready') {
        if (result.pullRequest) {
          setHasReadyPullRequest(true);
          onPullRequestReady(result.pullRequest);
        }
        setMessage(result.message ?? (
          result.pullRequest
            ? `Draft pull request #${result.pullRequest.number} is ready.`
            : `Branch ${result.branch.name} is active.`
        ));
        return;
      }
      setError(result.message ?? (
        result.state === 'partial'
          ? 'The branch is ready, but the draft pull request still needs attention.'
          : 'Development setup could not be completed.'
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Development setup could not be completed.');
    } finally {
      setIsStarting(false);
    }
  }

  if (!showSetup) {
    return (
      <section className="grid gap-3">
        <div>
          <p className="text-xs font-medium text-current/55">Backlog</p>
          <p className="mt-1 text-sm leading-6 text-current/45">
            Create a linked branch and start coding. Open a Draft PR after the first real commit.
          </p>
        </div>
        <Button className="w-full" onPress={() => setShowSetup(true)}>
          <GitBranchPlus className="size-4" /> Start development
        </Button>
      </section>
    );
  }

  return (
    <section className="issue-rise-in grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-current/60">
            {linkedBranch
              ? 'Active · Branch'
              : isBlockedRecovery
                ? 'Resolve development setup'
                : 'Start development'}
          </p>
          <p className="mt-1 text-xs leading-5 text-current/40">
            {linkedBranch
              ? 'The linked branch is ready for coding. A Draft PR is the next Active step once it has a real commit.'
              : isBlockedRecovery
                ? 'Project Space found GitHub state that must be verified or resolved before coding can start.'
              : 'Create the GitHub branch, then choose where to code.'}
          </p>
        </div>
      </div>

      <label className="grid gap-1.5">
        <span className="px-1 text-[11px] font-medium text-current/35">
          {linkedBranch ? 'Linked branch' : isBlockedRecovery ? 'Requested branch' : 'New branch'}
        </span>
        <span className="flex h-10 min-w-0 items-center gap-2 rounded-xl bg-current/[.055] px-3 ring-1 ring-inset ring-current/[.07]">
          <GitBranch className="size-3.5 shrink-0 text-current/35" />
          <input
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-current outline-none disabled:text-current/45"
            disabled={Boolean(linkedBranch) || isBlockedRecovery || isStarting}
            onChange={(event) => setBranchName(event.currentTarget.value)}
            value={linkedBranch?.name ?? branchName}
          />
        </span>
      </label>

      <div aria-live="polite" className="grid gap-1 rounded-xl bg-current/[.035] px-3 py-2 text-xs">
        <div className="flex min-h-7 items-center gap-2">
          {isStarting ? <LoaderCircle className="size-3.5 animate-spin text-blue-300" /> : <GitBranch className="size-3.5 text-current/35" />}
          <span className="text-current/55">Branch</span>
          <span className="ml-auto text-current/30">{linkedBranch ? 'Active' : 'Create'}</span>
        </div>
        <div className="flex min-h-7 items-center gap-2">
          {hasReadyPullRequest ? <Check className="size-3.5 text-emerald-300" /> : isStarting ? <LoaderCircle className="size-3.5 animate-spin text-blue-300" /> : <GitPullRequestDraft className="size-3.5 text-current/35" />}
          <span className="text-current/55">Draft PR</span>
          <span className="ml-auto text-current/30">
            {hasReadyPullRequest ? 'Ready' : linkedBranch && !canCreatePullRequest ? 'After first commit' : 'Next'}
          </span>
        </div>
      </div>

      {recoveryMessage && !error ? <p className="text-xs leading-5 text-amber-300">{recoveryMessage}</p> : null}
      {message ? <p className="text-xs leading-5 text-emerald-300">{message}</p> : null}
      {error ? <p className="text-xs leading-5 text-red-300">{error}</p> : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        {!linkedBranch ? (
          <Button className="flex-1" isDisabled={isStarting} size="sm" variant="ghost" onPress={() => setShowSetup(false)}>
            Cancel
          </Button>
        ) : null}
        <Button
          className="flex-1"
          isDisabled={isStarting || !repoFullName || !(linkedBranch?.name ?? branchName).trim() || Boolean(linkedBranch && !canCreatePullRequest)}
          size="sm"
          onPress={() => void startDevelopment()}
        >
          {!isStarting ? linkedBranch ? <GitPullRequestDraft className="size-4" /> : <Plus className="size-4" /> : null}
          {isStarting
            ? linkedBranch ? 'Creating Draft PR…' : 'Creating branch…'
            : linkedBranch
              ? 'Create Draft PR'
              : isBlockedRecovery
                ? 'Retry verification'
                : 'Create branch'}
        </Button>
      </div>
    </section>
  );
}
