import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import {
  authorAvatarStyle,
  issueColumnById,
  issueUpdatedAtLabel,
  labelChipStyle,
  type IssueColumnId
} from './issue-board-model';

export function IssueLabelChip({ className, label }: { className?: string; label: string }) {
  return (
    <span
      style={labelChipStyle(label)}
      className={cn(
        'inline-flex max-w-36 items-center truncate rounded-full border px-1.5 py-px text-[10px] font-medium leading-4',
        className
      )}
    >
      {label}
    </span>
  );
}

export function IssueStatusDot({
  className,
  columnId
}: {
  className?: string;
  columnId: IssueColumnId;
}) {
  const column = issueColumnById(columnId);

  return (
    <span
      title={column.label}
      className={cn('inline-block size-1.5 shrink-0 rounded-full', column.dotClass, className)}
    />
  );
}

export function IssueAuthorAvatar({
  author,
  className
}: {
  author: string;
  className?: string;
}) {
  return (
    <span
      style={authorAvatarStyle(author)}
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold uppercase',
        className
      )}
    >
      {author.slice(0, 1)}
    </span>
  );
}

export function IssueAuthorLine({
  className,
  issue
}: {
  className?: string;
  issue: GitHubIssueRecord;
}) {
  const updated = issueUpdatedAtLabel(issue);

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      {issue.author ? (
        <>
          <IssueAuthorAvatar author={issue.author} />
          <Text className="truncate text-[11px] text-neutral-500">{issue.author}</Text>
        </>
      ) : (
        <Text className="text-[11px] text-neutral-600">no author</Text>
      )}
      {updated ? (
        <Text className="ml-auto shrink-0 font-mono text-[10px] text-neutral-600">{updated}</Text>
      ) : null}
    </div>
  );
}
