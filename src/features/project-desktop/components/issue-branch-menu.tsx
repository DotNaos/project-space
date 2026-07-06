import { useMemo, useState } from 'react';
import { GitBranch, GitBranchPlus, GitPullRequest } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import {
  branchNameForIssue,
  issueBranchesForIssue
} from './issue-branch-model';

export function IssueBranchChip({
  branch,
  className
}: {
  branch: GitHubBranchRecord;
  className?: string;
}) {
  return (
    <span
      title={branch.name}
      className={cn(
        'inline-flex min-w-0 max-w-44 items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-200',
        className
      )}
    >
      <GitBranch className="size-3 shrink-0 text-sky-300/80" />
      <span className="min-w-0 truncate font-mono">{branch.name}</span>
    </span>
  );
}

export function IssuePullRequestChip({
  className,
  pullRequest
}: {
  className?: string;
  pullRequest: GitHubPullRequestRecord;
}) {
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      title={pullRequest.title}
      className={cn(
        'inline-flex min-w-0 max-w-36 items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-200 transition hover:border-violet-400/40 hover:text-violet-100',
        className
      )}
    >
      <GitPullRequest className="size-3 shrink-0 text-violet-300/80" />
      <span className="shrink-0 font-mono">#{pullRequest.number}</span>
      <span className="min-w-0 truncate">{pullRequest.state}</span>
    </a>
  );
}

export function IssueBranchMenu({
  branches,
  className,
  defaultBranch,
  issue,
  onBranchCreated,
  repoFullName
}: {
  branches: GitHubBranchRecord[];
  className?: string;
  defaultBranch: string;
  issue: GitHubIssueRecord;
  onBranchCreated(branch: GitHubBranchRecord): void;
  repoFullName?: string;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState('');
  const linkedBranches = issueBranchesForIssue({ branches, issue });
  const suggestedBranch = branchNameForIssue(issue);
  const primaryBranch = linkedBranches[0];
  const visibleBranches = useMemo(
    () =>
      branches
        .filter((branch) => !branch.isDefault)
        .filter((branch) => !branch.linkedIssueNumbers?.includes(issue.number))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 6),
    [branches, issue.number]
  );

  async function createLinkedBranch(name: string, sourceBranch: string) {
    if (!repoFullName) {
      setMessage('No repository linked.');
      return;
    }

    setIsCreating(true);
    setMessage('');
    try {
      const result = await projectSpaceClient.createGitHubBranch({
        fullName: repoFullName,
        issueNumber: issue.number,
        name,
        sourceBranch
      });

      if (result.status !== 'connected' || !result.branch) {
        setMessage(result.message ?? 'Could not create branch.');
        return;
      }

      onBranchCreated(result.branch);
      setMessage('Linked branch created.');
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <Dropdown>
      <DropdownTrigger
        data-no-drag
        className={cn(
          'inline-flex min-w-0 items-center justify-center rounded-full text-left transition',
          !primaryBranch &&
            'gap-1 border border-neutral-800 bg-neutral-900/80 px-2 py-0.5 text-[11px] text-neutral-500 opacity-0 hover:border-neutral-700 hover:text-neutral-200 group-hover/row:opacity-100 group-hover:opacity-100',
          className
        )}
      >
        {primaryBranch ? (
          <IssueBranchChip branch={primaryBranch} />
        ) : (
          <>
            <GitBranchPlus className="size-3" />
            Branch
          </>
        )}
      </DropdownTrigger>
      <DropdownPopover className="w-72">
        <DropdownMenu aria-label={`Branches for issue #${issue.number}`} className="p-1">
          <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
            Branches
          </div>
          {linkedBranches.length > 0 ? (
            linkedBranches.map((branch) => (
              <DropdownItem
                key={`linked:${branch.name}`}
                onPress={() => {
                  if (branch.url) {
                    window.open(branch.url, '_blank', 'noreferrer');
                  }
                }}
                className="rounded-lg px-3 py-2 text-xs text-neutral-200"
                textValue={branch.name}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch className="size-3.5 shrink-0 text-sky-300" />
                  <span className="min-w-0 truncate font-mono">{branch.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-emerald-300">linked</span>
                </div>
              </DropdownItem>
            ))
          ) : (
            <div className="px-3 py-2 text-xs text-neutral-500">No branch linked yet.</div>
          )}
          {linkedBranches.length === 0 && visibleBranches.length > 0 ? (
            <>
              <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600">
                Existing branches
              </div>
              {visibleBranches.map((branch) => (
                <DropdownItem
                  key={`existing:${branch.name}`}
                  onPress={() => void createLinkedBranch(branch.name, branch.name)}
                  className="rounded-lg px-3 py-2 text-xs text-neutral-300"
                  textValue={branch.name}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <GitBranch className="size-3.5 shrink-0 text-neutral-500" />
                    <span className="min-w-0 truncate font-mono">{branch.name}</span>
                  </div>
                </DropdownItem>
              ))}
            </>
          ) : null}
          <div className="px-2 pb-2 pt-1">
            <button
              type="button"
              disabled={isCreating || !repoFullName || linkedBranches.length > 0}
              onClick={() => void createLinkedBranch(suggestedBranch, defaultBranch)}
              className="flex w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-100 transition hover:bg-neutral-700 disabled:pointer-events-none disabled:opacity-50"
            >
              <GitBranchPlus className="size-3.5" />
              {isCreating ? 'Creating...' : 'Create linked branch'}
            </button>
            <Text className="mt-1 block truncate font-mono text-[10px] text-neutral-600">
              {suggestedBranch}
            </Text>
            {message ? <Text className="mt-1 block text-xs text-neutral-500">{message}</Text> : null}
          </div>
        </DropdownMenu>
      </DropdownPopover>
    </Dropdown>
  );
}
