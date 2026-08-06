import { useState, type CSSProperties } from 'react';
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
import { resolveIssueDevelopmentHead } from './issue-development-head';
import {
  groupIssuesByColumn,
  type IssueColumnDefinition
} from './issue-board-model';
import { IssueAuthorLine, IssueLabelChip } from './issue-visuals';

export function IssueKanbanBoard({
  branches,
  defaultBranch,
  issues,
  onBranchCreated,
  onOpenIssue,
  pullRequests,
  repoFullName,
  visibleColumns
}: {
  branches: GitHubBranchRecord[];
  defaultBranch: string;
  issues: GitHubIssueRecord[];
  onBranchCreated(branch: GitHubBranchRecord): void;
  onOpenIssue(issueNumber: number): void;
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
  visibleColumns: IssueColumnDefinition[];
}) {
  const [activeColumnIndex, setActiveColumnIndex] = useState(0);
  const groups = groupIssuesByColumn(issues, pullRequests);

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      aria-label="Issue board derived from GitHub"
    >
      <div
        onScroll={(event) => {
          const scroller = event.currentTarget;
          const columns = Array.from(
            scroller.querySelectorAll<HTMLElement>('[data-board-column]')
          );
          if (columns.length === 0) return;
          const center = scroller.scrollLeft + scroller.clientWidth / 2;
          let nearestIndex = 0;
          let nearestDistance = Number.POSITIVE_INFINITY;
          columns.forEach((column, index) => {
            const distance = Math.abs(column.offsetLeft + column.offsetWidth / 2 - center);
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearestIndex = index;
            }
          });
          setActiveColumnIndex(nearestIndex);
        }}
        className="flex h-full min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-2 sm:snap-proximity lg:snap-none"
      >
        {visibleColumns.map((column) => (
          <BoardColumn
            key={column.id}
            branches={branches}
            column={column}
            defaultBranch={defaultBranch}
            issues={groups[column.id]}
            onBranchCreated={onBranchCreated}
            onOpenIssue={onOpenIssue}
            pullRequests={pullRequests}
            repoFullName={repoFullName}
          />
        ))}
      </div>
      {visibleColumns.length > 1 ? (
        <div
          className="flex h-5 shrink-0 items-center justify-center gap-1.5 sm:hidden"
          aria-hidden="true"
        >
          {visibleColumns.map((column, index) => (
            <span
              key={column.id}
              className={cn(
                'h-1.5 rounded-full transition-all',
                index === activeColumnIndex
                  ? 'w-5 bg-neutral-300'
                  : 'w-1.5 bg-neutral-700'
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function BoardColumn({
  branches,
  column,
  defaultBranch,
  issues,
  onBranchCreated,
  onOpenIssue,
  pullRequests,
  repoFullName
}: {
  branches: GitHubBranchRecord[];
  column: IssueColumnDefinition;
  defaultBranch: string;
  issues: GitHubIssueRecord[];
  onBranchCreated(branch: GitHubBranchRecord): void;
  onOpenIssue(issueNumber: number): void;
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
}) {
  return (
    <section
      data-board-column
      aria-label={`${column.label} column`}
      className="flex h-full min-h-0 w-[calc(100vw-3.5rem)] max-w-[22rem] shrink-0 snap-center flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40 sm:w-[20rem] sm:snap-start md:w-[21rem] lg:w-80"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-neutral-800/60 px-3 py-2.5">
        <span className={cn('size-1.5 rounded-full', column.dotClass)} />
        <Text className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-300">
          {column.label}
        </Text>
        <Text className="ml-auto font-mono text-[11px] tabular-nums text-neutral-500">
          {issues.length}
        </Text>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {issues.map((issue, index) => (
          <BoardCard
            key={issue.number}
            branches={branches}
            defaultBranch={defaultBranch}
            issue={issue}
            onBranchCreated={onBranchCreated}
            onOpenIssue={onOpenIssue}
            pullRequests={pullRequests}
            repoFullName={repoFullName}
            style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
          />
        ))}
        {issues.length === 0 ? (
          <div className="flex min-h-24 flex-1 items-center justify-center rounded-lg border border-dashed border-neutral-800/80 px-3 text-center text-xs text-neutral-600">
            {column.hint}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BoardCard({
  branches,
  defaultBranch,
  issue,
  onBranchCreated,
  onOpenIssue,
  pullRequests,
  repoFullName,
  style
}: {
  branches: GitHubBranchRecord[];
  defaultBranch: string;
  issue: GitHubIssueRecord;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onOpenIssue(issueNumber: number): void;
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
  style?: CSSProperties;
}) {
  const developmentHead = resolveIssueDevelopmentHead({
    branches,
    issue,
    pullRequests,
    repositoryFullName: repoFullName
  });
  const hasDevelopmentHead = developmentHead.state !== 'none';

  return (
    <article
      style={style}
      className="issue-rise-in group relative shrink-0 rounded-lg border border-neutral-800/80 bg-neutral-900/50 transition hover:-translate-y-px hover:border-neutral-700 hover:bg-neutral-900 hover:shadow-lg hover:shadow-black/30"
    >
      <button
        type="button"
        onClick={() => onOpenIssue(issue.number)}
        className="block w-full min-w-0 p-3 pb-14 pr-12 text-left [@media(pointer:fine)]:pb-3 [@media(pointer:fine)]:pr-3"
      >
        <BoardCardContent issue={issue} pullRequests={pullRequests} />
      </button>
      <div
        className={cn(
          'absolute bottom-1.5 left-3 right-14 top-auto transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:fine)]:bottom-auto [@media(pointer:fine)]:left-auto [@media(pointer:fine)]:right-8 [@media(pointer:fine)]:top-1.5',
          hasDevelopmentHead
            ? 'opacity-100'
            : 'opacity-100 [@media(pointer:fine)]:opacity-0'
        )}
      >
        <IssueBranchMenu
          branches={branches}
          className="max-w-full min-h-11 px-3 opacity-100 [@media(pointer:fine)]:min-h-0 [@media(pointer:fine)]:max-w-28 [@media(pointer:fine)]:px-0"
          defaultBranch={defaultBranch}
          issue={issue}
          onBranchCreated={onBranchCreated}
          pullRequests={pullRequests}
          repoFullName={repoFullName}
        />
      </div>
      {issue.url ? (
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open issue #${issue.number} on GitHub`}
          title="Open on GitHub"
          className="absolute bottom-1.5 right-1.5 flex size-11 items-center justify-center rounded-xl text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-100 [@media(pointer:fine)]:bottom-2 [@media(pointer:fine)]:right-2 [@media(pointer:fine)]:size-6 [@media(pointer:fine)]:rounded-md [@media(pointer:fine)]:text-neutral-500"
        >
          <GitHubMark className="size-3.5" />
        </a>
      ) : null}
    </article>
  );
}

function BoardCardContent({
  issue,
  pullRequests
}: {
  issue: GitHubIssueRecord;
  pullRequests: GitHubPullRequestRecord[];
}) {
  const linkedPullRequests = issuePullRequestsForIssue({
    issue,
    pullRequests
  });

  return (
    <div className="min-w-0">
      <div className="flex h-5 min-w-0 items-center gap-1.5 overflow-hidden">
        <Text className="shrink-0 font-mono text-[11px] text-neutral-500">
          #{issue.number}
        </Text>
        {issue.labels.slice(0, 2).map((label) => (
          <IssueLabelChip key={label} label={label} />
        ))}
        {issue.labels.length > 2 ? (
          <Text className="shrink-0 text-[10px] text-neutral-600">
            +{issue.labels.length - 2}
          </Text>
        ) : null}
      </div>
      <Text className="mt-1.5 line-clamp-2 min-h-[2lh] text-sm font-medium leading-snug text-neutral-100">
        {issue.title}
      </Text>
      {linkedPullRequests.length > 0 ? (
        <div className="mt-1.5 flex min-w-0 flex-wrap gap-1">
          {linkedPullRequests.slice(0, 2).map((pullRequest) => (
            <IssuePullRequestChip
              key={pullRequest.number}
              pullRequest={pullRequest}
              className="max-w-full"
            />
          ))}
        </div>
      ) : null}
      <IssueAuthorLine issue={issue} className="mt-2.5 h-4 pr-7" />
    </div>
  );
}
