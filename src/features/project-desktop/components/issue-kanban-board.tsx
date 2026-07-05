import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowRightLeft } from 'lucide-react';
import {
  Dropdown,
  DropdownItem,
  DropdownMenu,
  DropdownPopover,
  DropdownTrigger,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import {
  groupIssuesByColumn,
  type IssueColumnDefinition,
  type IssueColumnId,
  type IssueColumnOverrides
} from './issue-board-model';
import { IssueAuthorLine, IssueLabelChip } from './issue-visuals';

const dragActivationDistance = 5;

interface BoardDragState {
  active: boolean;
  fromColumn: IssueColumnId;
  issue: GitHubIssueRecord;
  offsetX: number;
  offsetY: number;
  originX: number;
  originY: number;
  width: number;
  x: number;
  y: number;
}

export function IssueKanbanBoard({
  issues,
  onMoveIssue,
  onOpenIssue,
  overrides,
  visibleColumns
}: {
  issues: GitHubIssueRecord[];
  onMoveIssue(issueNumber: number, columnId: IssueColumnId): void;
  onOpenIssue(issueNumber: number): void;
  overrides: IssueColumnOverrides;
  visibleColumns: IssueColumnDefinition[];
}) {
  const [drag, setDrag] = useState<BoardDragState | null>(null);
  const [dropTarget, setDropTarget] = useState<IssueColumnId | null>(null);
  const dragRef = useRef<BoardDragState | null>(null);
  const suppressClickRef = useRef(false);
  const columnRefs = useRef(new Map<IssueColumnId, HTMLElement>());

  const groups = groupIssuesByColumn(issues, overrides);

  const updateDrag = (next: BoardDragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const moveIssueRef = useRef(onMoveIssue);

  moveIssueRef.current = onMoveIssue;

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    issue: GitHubIssueRecord,
    fromColumn: IssueColumnId
  ) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-no-drag]')) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();

    updateDrag({
      active: false,
      fromColumn,
      issue,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      originX: event.clientX,
      originY: event.clientY,
      width: rect.width,
      x: event.clientX,
      y: event.clientY
    });
  };

  const isDragPending = drag !== null;

  useEffect(() => {
    if (!isDragPending) {
      return;
    }

    const hitTestColumn = (x: number, y: number): IssueColumnId | null => {
      for (const [columnId, element] of columnRefs.current) {
        const rect = element.getBoundingClientRect();

        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          return columnId;
        }
      }

      return null;
    };

    const handleMove = (event: PointerEvent) => {
      const current = dragRef.current;

      if (!current) {
        return;
      }

      const active =
        current.active ||
        Math.hypot(event.clientX - current.originX, event.clientY - current.originY) >
          dragActivationDistance;

      updateDrag({ ...current, active, x: event.clientX, y: event.clientY });
      setDropTarget(active ? hitTestColumn(event.clientX, event.clientY) : null);
    };

    const endDrag = (commit: boolean, x?: number, y?: number) => {
      const current = dragRef.current;

      if (!current) {
        return;
      }

      if (current.active) {
        // The click that follows pointerup on the dragged card must not open the issue.
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);

        if (commit && x !== undefined && y !== undefined) {
          const target = hitTestColumn(x, y);

          if (target && target !== current.fromColumn) {
            moveIssueRef.current(current.issue.number, target);
          }
        }
      }

      updateDrag(null);
      setDropTarget(null);
    };

    const handleUp = (event: PointerEvent) => endDrag(true, event.clientX, event.clientY);
    const handleCancel = () => endDrag(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        endDrag(false);
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDragPending]);

  const isDragActive = drag?.active ?? false;

  useEffect(() => {
    if (!isDragActive) {
      return;
    }

    document.body.classList.add('issue-dragging');

    return () => {
      document.body.classList.remove('issue-dragging');
    };
  }, [isDragActive]);

  return (
    <div className="flex h-full min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden pb-2">
      {visibleColumns.map((column) => (
        <BoardColumn
          key={column.id}
          column={column}
          moveTargets={visibleColumns.filter((target) => target.id !== column.id)}
          columnRef={(element) => {
            if (element) {
              columnRefs.current.set(column.id, element);
            } else {
              columnRefs.current.delete(column.id);
            }
          }}
          draggedIssueNumber={isDragActive ? (drag?.issue.number ?? null) : null}
          isDragActive={isDragActive}
          isDropTarget={isDragActive && dropTarget === column.id}
          issues={groups[column.id]}
          onCardPointerDown={beginDrag}
          onMoveIssue={onMoveIssue}
          onOpenIssue={onOpenIssue}
          suppressClickRef={suppressClickRef}
        />
      ))}
      {drag?.active
        ? createPortal(
            <div
              className="pointer-events-none fixed left-0 top-0 z-[100]"
              style={{
                transform: `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px)`,
                width: drag.width
              }}
            >
              <div className="issue-drag-preview rounded-lg border border-neutral-600/80 bg-neutral-900 shadow-2xl shadow-black/60 ring-1 ring-white/10">
                <BoardCardContent issue={drag.issue} className="p-3" />
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function BoardColumn({
  column,
  columnRef,
  draggedIssueNumber,
  isDragActive,
  isDropTarget,
  issues,
  moveTargets,
  onCardPointerDown,
  onMoveIssue,
  onOpenIssue,
  suppressClickRef
}: {
  column: IssueColumnDefinition;
  columnRef(element: HTMLElement | null): void;
  draggedIssueNumber: number | null;
  isDragActive: boolean;
  isDropTarget: boolean;
  issues: GitHubIssueRecord[];
  moveTargets: IssueColumnDefinition[];
  onCardPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    issue: GitHubIssueRecord,
    fromColumn: IssueColumnId
  ): void;
  onMoveIssue(issueNumber: number, columnId: IssueColumnId): void;
  onOpenIssue(issueNumber: number): void;
  suppressClickRef: { current: boolean };
}) {
  return (
    <section
      ref={columnRef}
      aria-label={`${column.label} column`}
      className={cn(
        'flex h-full min-h-0 w-80 shrink-0 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40 transition-colors',
        isDropTarget && column.dropClass
      )}
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
            column={column}
            isDragSource={draggedIssueNumber === issue.number}
            issue={issue}
            moveTargets={moveTargets}
            onMoveIssue={onMoveIssue}
            onOpenIssue={onOpenIssue}
            onPointerDown={onCardPointerDown}
            style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            suppressClickRef={suppressClickRef}
          />
        ))}
        {issues.length === 0 ? (
          <div
            className={cn(
              'flex min-h-24 flex-1 items-center justify-center rounded-lg border border-dashed border-neutral-800/80 px-3 text-center text-xs transition-colors',
              isDragActive ? 'text-neutral-300' : 'text-neutral-600'
            )}
          >
            {isDragActive ? 'Drop here' : column.hint}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BoardCard({
  column,
  isDragSource,
  issue,
  moveTargets,
  onMoveIssue,
  onOpenIssue,
  onPointerDown,
  style,
  suppressClickRef
}: {
  column: IssueColumnDefinition;
  isDragSource: boolean;
  issue: GitHubIssueRecord;
  moveTargets: IssueColumnDefinition[];
  onMoveIssue(issueNumber: number, columnId: IssueColumnId): void;
  onOpenIssue(issueNumber: number): void;
  onPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    issue: GitHubIssueRecord,
    fromColumn: IssueColumnId
  ): void;
  style?: React.CSSProperties;
  suppressClickRef: { current: boolean };
}) {
  return (
    <article
      onPointerDown={(event) => onPointerDown(event, issue, column.id)}
      onClickCapture={(event) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      style={style}
      className={cn(
        'issue-rise-in group relative shrink-0 cursor-grab touch-none select-none rounded-lg border border-neutral-800/80 bg-neutral-900/50 transition hover:-translate-y-px hover:border-neutral-700 hover:bg-neutral-900 hover:shadow-lg hover:shadow-black/30',
        isDragSource && 'opacity-30 saturate-50'
      )}
    >
      <button
        type="button"
        onClick={() => onOpenIssue(issue.number)}
        className="block w-full min-w-0 cursor-[inherit] p-3 text-left"
      >
        <BoardCardContent issue={issue} />
      </button>
      {moveTargets.length > 0 ? (
        <div
          data-no-drag
          className="absolute right-1.5 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
        >
          <Dropdown>
            <DropdownTrigger
              aria-label={`Move issue #${issue.number} to another column`}
              className="size-6 rounded-md border-transparent bg-neutral-900/80 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <ArrowRightLeft className="size-3" />
            </DropdownTrigger>
            <DropdownPopover className="w-40">
              <DropdownMenu aria-label="Move issue to column">
                {moveTargets.map((target) => (
                  <DropdownItem
                    key={target.id}
                    onPress={() => onMoveIssue(issue.number, target.id)}
                    className="flex items-center gap-2 text-xs"
                  >
                    <span className={cn('size-1.5 rounded-full', target.dotClass)} />
                    {target.label}
                  </DropdownItem>
                ))}
              </DropdownMenu>
            </DropdownPopover>
          </Dropdown>
        </div>
      ) : null}
    </article>
  );
}

function BoardCardContent({
  className,
  issue
}: {
  className?: string;
  issue: GitHubIssueRecord;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex h-5 min-w-0 items-center gap-1.5 overflow-hidden">
        <Text className="shrink-0 font-mono text-[11px] text-neutral-500">#{issue.number}</Text>
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
      <IssueAuthorLine issue={issue} className="mt-2.5 h-4" />
    </div>
  );
}
