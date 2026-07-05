import { useEffect, useState } from 'react';
import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import { GitHubMark } from './github-mark';
import {
  issueUpdatedAtLabel,
  loadIssueColumnOverrides,
  resolveIssueColumn,
  type IssueColumnOverrides
} from './issue-board-model';
import { IssueAuthorAvatar, IssueLabelChip, IssueStatusDot } from './issue-visuals';

export function IssueListView({
  issues,
  onOpenIssue,
  repoFullName
}: {
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
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
            key={issue.number}
            columnId={resolveIssueColumn(issue, index, overrides)}
            isLast={index === issues.length - 1}
            issue={issue}
            onOpenIssue={onOpenIssue}
          />
        ))}
      </div>
    </div>
  );
}

function IssueListRow({
  columnId,
  isLast,
  issue,
  onOpenIssue
}: {
  columnId: ReturnType<typeof resolveIssueColumn>;
  isLast: boolean;
  issue: GitHubIssueRecord;
  onOpenIssue(issueNumber: number): void;
}) {
  const updated = issueUpdatedAtLabel(issue);

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
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left"
      >
        <Text className="w-12 shrink-0 font-mono text-xs tabular-nums text-neutral-500">
          #{issue.number}
        </Text>
        <Text className="min-w-0 truncate text-sm font-medium text-neutral-100">
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
      <span className="hidden shrink-0 items-center gap-1.5 lg:flex">
        {issue.author ? (
          <>
            <IssueAuthorAvatar author={issue.author} />
            <Text className="max-w-28 truncate text-[11px] text-neutral-500">{issue.author}</Text>
          </>
        ) : null}
      </span>
      {updated ? (
        <Text className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-600">
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
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-600 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <GitHubMark className="size-3.5" />
        </a>
      ) : (
        <span className="size-7 shrink-0" />
      )}
    </div>
  );
}
