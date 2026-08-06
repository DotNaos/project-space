import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import { resolveIssueColumn } from './issue-board-model';
import { IssueStatusDot } from './issue-visuals';

interface IssueDetailListProps {
  className?: string;
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
  pullRequests: GitHubPullRequestRecord[];
  selectedIssueNumber: number;
}

export function IssueDetailList({
  className,
  issues,
  onOpenIssue,
  pullRequests,
  selectedIssueNumber
}: IssueDetailListProps) {
  return (
    <aside className={cn('min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40', className ?? 'flex')}>
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800/60 px-3 py-2.5">
        <Text className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-300">
          Issues
        </Text>
        <Text className="ml-auto font-mono text-[11px] tabular-nums text-neutral-500">
          {issues.length}
        </Text>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
        {issues.map((entry) => {
          const isSelected = entry.number === selectedIssueNumber;

          return (
            <button
              key={entry.number}
              type="button"
              onClick={() => onOpenIssue(entry.number)}
              aria-current={isSelected ? 'true' : undefined}
              className={cn(
                'relative min-w-0 rounded-lg px-2.5 py-2 text-left transition',
                isSelected ? 'bg-neutral-800/80' : 'hover:bg-neutral-900/60'
              )}
            >
              {isSelected ? (
                <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-neutral-100" />
              ) : null}
              <span className="flex items-center gap-1.5">
                <IssueStatusDot columnId={resolveIssueColumn(entry, pullRequests)} />
                <Text className="font-mono text-[11px] tabular-nums text-neutral-500">
                  #{entry.number}
                </Text>
              </span>
              <Text
                className={cn(
                  'mt-0.5 block truncate text-sm',
                  isSelected ? 'font-medium text-neutral-50' : 'text-neutral-300'
                )}
              >
                {entry.title}
              </Text>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
