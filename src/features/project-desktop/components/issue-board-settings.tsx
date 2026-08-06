import { Check, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import {
  Dropdown,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { IssueColumnDefinition, IssueColumnId } from './issue-board-model';

interface IssueBoardSettingsProps {
  counts: Record<IssueColumnId, number>;
  hiddenColumns: ReadonlySet<IssueColumnId>;
  onMoveColumn(columnId: IssueColumnId, direction: -1 | 1): void;
  onToggleColumn(columnId: IssueColumnId): void;
  orderedColumns: IssueColumnDefinition[];
  visibleColumnCount: number;
}

export function IssueBoardSettings({
  counts,
  hiddenColumns,
  onMoveColumn,
  onToggleColumn,
  orderedColumns,
  visibleColumnCount
}: IssueBoardSettingsProps) {
  return (
    <Dropdown>
      <DropdownTrigger
        aria-label="Show, hide, or reorder board columns"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border-neutral-800 bg-neutral-900/50 text-neutral-400 hover:text-neutral-200"
      >
        <SlidersHorizontal className="size-4" />
      </DropdownTrigger>
      <DropdownPopover className="w-64">
        <DropdownMenu aria-label="Configure board columns">
          <div className="px-3 pb-1 pt-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
              Board columns
            </div>
            <div className="mt-1 text-xs leading-5 text-neutral-400">
              Placement is derived from GitHub issue state and linked pull requests.
            </div>
          </div>
          {orderedColumns.map((column, index) => {
            const isVisible = !hiddenColumns.has(column.id);
            const isLastVisible = isVisible && visibleColumnCount === 1;
            return (
              <div
                key={column.id}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900/80"
              >
                <button
                  type="button"
                  disabled={isLastVisible}
                  onClick={() => onToggleColumn(column.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border transition',
                      isVisible
                        ? 'border-neutral-400 bg-neutral-200 text-neutral-900'
                        : 'border-neutral-700 text-transparent'
                    )}
                  >
                    {isVisible ? <Check className="size-3" strokeWidth={3} /> : null}
                  </span>
                  <span className={cn('size-1.5 shrink-0 rounded-full', column.dotClass)} />
                  <span className="min-w-0 flex-1 truncate">{column.label}</span>
                  <span className="font-mono text-[10px] tabular-nums text-neutral-600">
                    {counts[column.id]}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => onMoveColumn(column.id, -1)}
                  className="flex size-7 shrink-0 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:pointer-events-none disabled:opacity-25"
                  aria-label={`Move ${column.label} left`}
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <button
                  type="button"
                  disabled={index === orderedColumns.length - 1}
                  onClick={() => onMoveColumn(column.id, 1)}
                  className="flex size-7 shrink-0 items-center justify-center rounded text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200 disabled:pointer-events-none disabled:opacity-25"
                  aria-label={`Move ${column.label} right`}
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
            );
          })}
        </DropdownMenu>
      </DropdownPopover>
    </Dropdown>
  );
}
