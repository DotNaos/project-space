import { useEffect, useState } from 'react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import { GitHubMark } from './github-mark';
import { IssueBranchMenu, IssuePullRequestChip } from './issue-branch-menu';
import { issuePullRequestsForIssue } from './issue-branch-model';
import {
  issueUpdatedAtLabel,
  loadIssueColumnOverrides,
  resolveIssueColumn,
  type IssueColumnOverrides
} from './issue-board-model';
import { IssueAuthorAvatar, IssueLabelChip, IssueStatusDot } from './issue-visuals';

export function IssueListView({
  branches,
  defaultBranch,
  issues,
  onBranchCreated,
  onOpenIssue,
  pullRequests,
  repoFullName
}: {
  branches: GitHubBranchRecord[];
  defaultBranch: string;
  issues: GitHubIssueRecord[];
  onBranchCreated(branch: GitHubBranchRecord): void;
  onOpenIssue(issueNumber: number): void;
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
}) {
  const [overrides, setOverrides] = useState<IssueColumnOverrides>(() =>
    loadIssueColumnOverrides(repoFullName)
  );

  useEffect(() => {
    setOverrides(loadIssueColumnOverrides(repoFullName));
  }, [repoFullName]);

  return (
    <div className="issue-rise-in flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {issues.map((issue, index) => (
          <IssueListRow
            branches={branches}
            key={issue.number}
            columnId={resolveIssueColumn(issue, index, overrides)}
            defaultBranch={defaultBranch}
            isLast={index === issues.length - 1}
            issue={issue}
            onBranchCreated={onBranchCreated}
            onOpenIssue={onOpenIssue}
            pullRequests={pullRequests}
            repoFullName={repoFullName}
          />
        ))}
      </div>
    </div>
  );
}

function IssueListRow({
  branches,
  columnId,
  defaultBranch,
  isLast,
  issue,
  onBranchCreated,
  repoFullName,
  onOpenIssue,
  pullRequests
}: {
  branches: GitHubBranchRecord[];
  columnId: ReturnType<typeof resolveIssueColumn>;
  defaultBranch: string;
  isLast: boolean;
  issue: GitHubIssueRecord;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onOpenIssue(issueNumber: number): void;
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
}) {
  const updated = issueUpdatedAtLabel(issue);
  const issuePullRequests = issuePullRequestsForIssue({
    issue,
    pullRequests
  });

  return (
    <div
      className={cn(
        'group/row flex min-w-0 items-center gap-3 pl-3 pr-2 transition hover:bg-neutral-900/50',
        !isLast && 'border-b border-neutral-900'
      )}
    >
      <IssueStatusDot columnId={columnId} />
      <button
        type="button"
        onClick={() => onOpenIssue(issue.number)}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left max-sm:flex-col max-sm:items-start max-sm:gap-0.5"
      >
        <Text className="w-12 shrink-0 font-mono text-xs tabular-nums text-neutral-500 max-sm:w-auto">
          #{issue.number}
        </Text>
        <Text className="min-w-0 max-w-full truncate text-sm font-medium text-neutral-100">
          {issue.title}
        </Text>
        {issue.labels.length > 0 ? (
          <span className="hidden shrink-0 items-center gap-1 md:flex">
            {issue.labels.slice(0, 3).map((label) => (
              <IssueLabelChip key={label} label={label} />
            ))}
            {issue.labels.length > 3 ? (
              <Text className="text-[10px] text-neutral-600">+{issue.labels.length - 3}</Text>
            ) : null}
          </span>
        ) : null}
      </button>
      <IssueBranchMenu
        branches={branches}
        defaultBranch={defaultBranch}
        issue={issue}
        onBranchCreated={onBranchCreated}
        repoFullName={repoFullName}
      />
      {issuePullRequests.slice(0, 1).map((pullRequest) => (
        <IssuePullRequestChip
          key={pullRequest.number}
          pullRequest={pullRequest}
          className="hidden lg:inline-flex"
        />
      ))}
      <span className="hidden shrink-0 items-center gap-1.5 lg:flex">
        {issue.author ? (
          <>
            <IssueAuthorAvatar author={issue.author} />
            <Text className="max-w-28 truncate text-[11px] text-neutral-500">{issue.author}</Text>
          </>
        ) : null}
      </span>
      {updated ? (
        <Text className="hidden w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-600 sm:block">
          {updated}
        </Text>
      ) : null}
      {issue.url ? (
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open issue #${issue.number} on GitHub`}
          title="Open on GitHub"
          className="hidden size-7 shrink-0 items-center justify-center rounded-md text-neutral-600 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 focus-visible:opacity-100 group-hover/row:opacity-100 sm:flex"
        >
          <GitHubMark className="size-3.5" />
        </a>
      ) : (
        <span className="hidden size-7 shrink-0 sm:block" />
      )}
    </div>
  );
}
