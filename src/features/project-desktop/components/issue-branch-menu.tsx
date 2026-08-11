import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, GitBranch, GitBranchPlus, GitPullRequest, X } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import {
  ListBox,
  ListBoxItem,
  Select,
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
import { GitBranchCreatePreview } from './git-branch-create-preview';
import { resolveIssueDevelopmentHead } from './issue-development-head';
import { useRuntimeBinding } from './runtime-binding-context';

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
  const runtime = useRuntimeBinding();
  const classNames = cn(
    'inline-flex min-w-0 max-w-36 items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-200',
    runtime.apis === 'external' && pullRequest.url
      ? 'transition hover:border-violet-400/40 hover:text-violet-100'
      : '',
    className
  );
  const content = (
    <>
      <GitPullRequest className="size-3 shrink-0 text-violet-300/80" />
      <span className="shrink-0 font-mono">#{pullRequest.number}</span>
      <span className="min-w-0 truncate">{pullRequest.state}</span>
    </>
  );

  if (runtime.apis !== 'external' || !pullRequest.url) {
    return (
      <span title={pullRequest.title} className={classNames}>
        {content}
      </span>
    );
  }

  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      title={pullRequest.title}
      className={classNames}
    >
      {content}
    </a>
  );
}

export function IssueBranchMenu({
  branches,
  className,
  defaultBranch,
  issue,
  onBranchCreated,
  pullRequests,
  repoFullName
}: {
  branches: GitHubBranchRecord[];
  className?: string;
  defaultBranch: string;
  issue: GitHubIssueRecord;
  onBranchCreated(branch: GitHubBranchRecord): void;
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
}) {
  const [isCreating, setIsCreating] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [branchName, setBranchName] = useState('');
  const [baseBranchName, setBaseBranchName] = useState(defaultBranch);
  const linkedBranches = issueBranchesForIssue({ branches, issue });
  const developmentHead = resolveIssueDevelopmentHead({
    branches,
    issue,
    pullRequests,
    repositoryFullName: repoFullName
  });
  const suggestedBranch = branchNameForIssue(issue);
  const primaryBranch =
    developmentHead.state === 'verified' ? developmentHead.branch : undefined;
  const dialogBranches = primaryBranch ? [primaryBranch] : linkedBranches;
  const branchOptions = useMemo(() => {
    const names = new Set<string>();
    if (defaultBranch) {
      names.add(defaultBranch);
    }
    branches.forEach((branch) => names.add(branch.name));

    return Array.from(names).sort((left, right) => {
      if (left === defaultBranch) {
        return -1;
      }
      if (right === defaultBranch) {
        return 1;
      }
      return left.localeCompare(right);
    });
  }, [branches, defaultBranch]);
  const visibleBranches = useMemo(
    () =>
      branches
        .filter((branch) => !branch.isDefault)
        .filter((branch) => !branch.linkedIssueNumbers?.includes(issue.number))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 6),
    [branches, issue.number]
  );

  useEffect(() => {
    setBranchName(suggestedBranch);
    setBaseBranchName(defaultBranch);
    setMessage('');
  }, [defaultBranch, issue.number, suggestedBranch]);

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
      setIsOpen(false);
    } finally {
      setIsCreating(false);
    }
  }

  return (
    <>
      {developmentHead.state !== 'verified' && developmentHead.state !== 'none' ? (
        <span
          aria-label={developmentHead.message}
          title={developmentHead.message}
          className={cn(
            'inline-flex min-w-0 max-w-32 items-center gap-1 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200',
            className
          )}
        >
          <AlertTriangle className="size-3 shrink-0" />
          <span className="truncate">
            {developmentHead.state === 'ambiguous' ? 'Branch ambiguous' : 'Branch unavailable'}
          </span>
        </span>
      ) : primaryBranch ? (
        <IssueBranchChip branch={primaryBranch} className={className} />
      ) : (
        <button
          type="button"
          data-no-drag
          onClick={() => setIsOpen(true)}
          className={cn(
            'inline-flex min-w-0 items-center justify-center rounded-full text-left transition',
            'gap-1 border border-neutral-800 bg-neutral-900/80 px-2 py-0.5 text-[11px] text-neutral-500 opacity-0 hover:border-neutral-700 hover:text-neutral-200 group-hover/row:opacity-100 group-hover:opacity-100',
            className
          )}
        >
          <GitBranchPlus className="size-3" />
          Branch
        </button>
      )}

      {isOpen && developmentHead.state === 'none' && typeof document !== 'undefined' ? createPortal(
        <IssueBranchDialog
          baseBranchName={baseBranchName}
          branchName={branchName}
          branchOptions={branchOptions}
          defaultBranch={defaultBranch}
          isCreating={isCreating}
          linkedBranches={dialogBranches}
          message={message}
          onBaseBranchChange={setBaseBranchName}
          onBranchNameChange={setBranchName}
          onClose={() => setIsOpen(false)}
          onCreateBranch={() => void createLinkedBranch(branchName, baseBranchName)}
          onLinkExistingBranch={(branch) => void createLinkedBranch(branch.name, branch.name)}
          repoFullName={repoFullName}
          suggestedBranch={suggestedBranch}
          visibleBranches={visibleBranches}
        />,
        document.body
      ) : null}
    </>
  );
}

function IssueBranchDialog({
  baseBranchName,
  branchName,
  branchOptions,
  defaultBranch,
  isCreating,
  linkedBranches,
  message,
  onBaseBranchChange,
  onBranchNameChange,
  onClose,
  onCreateBranch,
  onLinkExistingBranch,
  repoFullName,
  suggestedBranch,
  visibleBranches
}: {
  baseBranchName: string;
  branchName: string;
  branchOptions: string[];
  defaultBranch: string;
  isCreating: boolean;
  linkedBranches: GitHubBranchRecord[];
  message: string;
  onBaseBranchChange(value: string): void;
  onBranchNameChange(value: string): void;
  onClose(): void;
  onCreateBranch(): void;
  onLinkExistingBranch(branch: GitHubBranchRecord): void;
  repoFullName?: string;
  suggestedBranch: string;
  visibleBranches: GitHubBranchRecord[];
}) {
  const canCreate = Boolean(repoFullName && branchName.trim() && baseBranchName && linkedBranches.length === 0);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-2 backdrop-blur-sm sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create linked branch"
        className="flex h-[calc(100dvh-1rem)] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl shadow-black/70 sm:h-auto sm:max-h-[calc(100dvh-1rem)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-800 px-3 py-2.5 sm:px-5 sm:py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-lg font-semibold text-neutral-100">
              <GitBranchPlus className="size-5 text-sky-300" />
              Create linked branch
            </div>
            <Text className="mt-1 block text-sm text-neutral-500">
              Start it from the selected branch tip.
            </Text>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-100"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(24rem,1fr)] gap-2 overflow-hidden px-3 py-2 sm:grid-rows-[auto_minmax(28rem,1fr)] sm:px-5 sm:py-3 md:grid-cols-[16rem_minmax(0,1fr)] md:grid-rows-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="grid min-w-0 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 md:block md:space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600 sm:text-xs">
                Base branch
              </span>
              <Select value={baseBranchName} onChange={(value) => value && onBaseBranchChange(value)}>
                <Select.Trigger className="h-9 rounded-lg border border-neutral-800 bg-neutral-950 px-3 text-left text-sm text-neutral-100 transition hover:border-neutral-700 sm:h-10">
                  <GitBranch className="size-4 shrink-0 text-sky-300" />
                  <span className="min-w-0 flex-1 truncate font-mono">{baseBranchName}</span>
                  <Select.Indicator className="text-neutral-500" />
                </Select.Trigger>
                <Select.Popover className="max-h-64 w-full overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
                  <ListBox selectedKeys={new Set([baseBranchName])}>
                    {branchOptions.map((branch) => (
                      <ListBoxItem
                        key={branch}
                        id={branch}
                        className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-100 data-[selected=true]:bg-neutral-800 data-[selected=true]:text-neutral-100"
                      >
                        <GitBranch className="size-4 shrink-0 text-neutral-500" />
                        <span className="min-w-0 flex-1 truncate font-mono">{branch}</span>
                        {branch === baseBranchName ? <Check className="size-4 shrink-0" /> : null}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600 sm:text-xs">
                New branch
              </span>
              <input
                value={branchName}
                onChange={(event) => onBranchNameChange(event.target.value)}
                className="h-9 w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 font-mono text-sm text-neutral-100 outline-none transition placeholder:text-neutral-700 focus:border-sky-500/60 sm:h-10"
                placeholder={suggestedBranch}
              />
            </label>

            {linkedBranches.length > 0 ? (
              <div className="sm:col-span-2 md:col-span-1">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600 sm:text-xs">
                  Linked branches
                </div>
                <div className="flex max-h-16 flex-wrap gap-1.5 overflow-y-auto pr-1 sm:max-h-20 md:max-h-24">
                  {linkedBranches.map((branch) => (
                    <div
                      key={branch.name}
                      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-emerald-500/15 bg-emerald-500/5 px-2.5 py-1 text-[11px] text-neutral-200"
                    >
                      <GitBranch className="size-3.5 shrink-0 text-emerald-300" />
                      <span className="min-w-0 truncate font-mono">{branch.name}</span>
                      <span className="ml-auto text-xs text-emerald-300">linked</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {linkedBranches.length === 0 && visibleBranches.length > 0 ? (
              <div className="sm:col-span-2 md:col-span-1">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-600 sm:text-xs">
                  Existing branches
                </div>
                <div className="flex max-h-16 flex-wrap gap-1.5 overflow-y-auto pr-1 sm:max-h-20 md:max-h-28">
                  {visibleBranches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      onClick={() => onLinkExistingBranch(branch)}
                      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border border-neutral-800 px-2.5 py-1 text-left text-[11px] text-neutral-300 transition hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-100"
                    >
                      <GitBranch className="size-3.5 shrink-0 text-neutral-500" />
                      <span className="min-w-0 truncate font-mono">{branch.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {message ? <Text className="block text-sm text-rose-300">{message}</Text> : null}
          </div>

          <div className="min-h-0 min-w-0">
            <GitBranchCreatePreview
              baseBranchName={baseBranchName}
              branchName={branchName || suggestedBranch}
              isBaseDefaultBranch={baseBranchName === defaultBranch}
              repositoryFullName={repoFullName}
            />
          </div>
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-neutral-800 px-3 py-2.5 sm:flex-row sm:justify-end sm:px-5 sm:py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-neutral-300 transition hover:bg-neutral-900 hover:text-neutral-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate || isCreating}
            onClick={onCreateBranch}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-neutral-100 px-4 py-2 text-sm font-semibold text-neutral-950 transition hover:bg-white disabled:pointer-events-none disabled:opacity-45"
          >
            <GitBranchPlus className="size-4" />
            {isCreating ? 'Creating...' : 'Create branch'}
          </button>
        </div>
      </div>
    </div>
  );
}
