import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleX,
  Flag,
  GitFork,
  GripVertical,
  LockKeyhole
} from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Handle,
  Position,
  type NodeProps
} from '@xyflow/react';

import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { RoadmapIssueAvailability } from '@/shared/roadmap-api';
import type { RoadmapLayoutNode } from './roadmap-layout';
import type { RoadmapFlowNode } from './roadmap-react-flow-model';
import { roadmapStatusLabel } from './roadmap-status';

const statusTone: Record<RoadmapIssueAvailability, string> = {
  blocked: 'border-amber-500/70 text-amber-300',
  closed: 'border-neutral-700 text-neutral-400',
  cyclic: 'border-rose-500/75 text-rose-300',
  inaccessible: 'border-violet-500/70 text-violet-300',
  missing: 'border-neutral-600 text-neutral-400',
  ready: 'border-neutral-700 text-emerald-300',
  stale: 'border-sky-500/70 text-sky-300'
};

export function RoadmapGraphNode({ data, selected }: NodeProps<RoadmapFlowNode>) {
  if (data.kind === 'goal') {
    return (
      <div className="pointer-events-none size-full rounded-2xl border border-dashed border-neutral-700/90 bg-neutral-950/10 px-4 py-3">
        <Text className="block truncate text-xs font-semibold text-neutral-300">
          Goal · {data.layoutGroup.goal.title}
        </Text>
      </div>
    );
  }
  const node = data.layoutNode;
  return (
    <div className="relative size-full">
      {node.incoming.length > 0 ? <EdgeHandle position={Position.Top} type="target" /> : null}
      <RoadmapIssueCard
        node={node}
        onReorderStart={data.onReorderStart
          ? (event) => data.onReorderStart?.(event, node.issue)
          : undefined}
        onSelect={() => data.onSelect?.(node.issue)}
        pending={data.pending}
        selected={selected}
      />
      {node.outgoing.length > 0 ? <EdgeHandle position={Position.Bottom} type="source" /> : null}
    </div>
  );
}

export function RoadmapIssueCard({
  node,
  onReorderStart,
  onSelect,
  pending = false,
  selected = false
}: {
  node: RoadmapLayoutNode;
  onReorderStart?(event: ReactPointerEvent<HTMLElement>): void;
  onSelect?(): void;
  pending?: boolean;
  selected?: boolean;
}) {
  const StatusIcon = statusIcon(node.issue.availability);
  const active = node.planItem?.plannedState === 'active';
  return (
    <button
      aria-current={active ? 'step' : undefined}
      aria-label={`Inspect issue #${node.issue.issue.number}: ${node.issue.title}`}
      className={cn(
        'nodrag nopan flex size-full min-w-0 flex-col rounded-xl border bg-neutral-950/95 px-3.5 py-3 text-left shadow-lg shadow-black/20 outline-none transition-[border-color,box-shadow,transform] duration-200 motion-reduce:transition-none',
        active
          ? '!border-emerald-200 !bg-emerald-600/65 !text-white ring-2 ring-emerald-300/70 shadow-[0_0_32px_rgba(16,185,129,0.45)]'
          : statusTone[node.issue.availability],
        selected && !active
          ? 'ring-2 ring-sky-300/55 shadow-xl shadow-black/35'
          : 'hover:border-neutral-400 focus-visible:ring-2 focus-visible:ring-neutral-300/70'
      )}
      data-roadmap-issue-id={node.issue.issue.id}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect?.();
      }}
      type="button"
    >
      <span className="flex min-w-0 items-start justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <StatusIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <Text className={cn('truncate font-mono text-[11px]', active ? 'text-emerald-50/80' : 'text-neutral-400')}>
            {node.issue.issue.fullName}#{node.issue.issue.number}
          </Text>
        </span>
        <Text className="shrink-0 rounded border border-current/30 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]">
          {pending ? 'Syncing' : active ? 'Current' : roadmapStatusLabel[node.issue.availability]}
        </Text>
      </span>
      <Text className="mt-2 line-clamp-3 text-[13px] font-semibold leading-[1.35] text-neutral-100">
        {node.issue.title}
      </Text>
      <span className="mt-auto flex min-w-0 items-end justify-between gap-2 pt-2">
        {node.planPosition ? (
          <span
            aria-hidden="true"
            className={cn(
              'nodrag inline-flex touch-none items-center gap-0.5 rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-neutral-400',
              onReorderStart && 'cursor-grab hover:border-neutral-500 active:cursor-grabbing'
            )}
            data-roadmap-reorder-handle={node.issue.issue.id}
            onPointerDown={(event) => {
              if (!onReorderStart) return;
              event.preventDefault();
              event.stopPropagation();
              onReorderStart(event);
            }}
            title={onReorderStart ? 'Drag to change manual plan position' : undefined}
          >
            {onReorderStart ? <GripVertical className="size-3" /> : null}
            <Text className="font-mono text-[10px] tabular-nums">
              Plan {String(node.planPosition).padStart(2, '0')}
            </Text>
          </span>
        ) : (
          <Text className="text-[10px] text-neutral-600">Context only</Text>
        )}
        <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500">
          {node.isRoot ? <><GitFork className="size-3" /> Root</> : null}
          {node.isTerminal ? <><Flag className="size-3" /> Ends here</> : null}
        </span>
      </span>
    </button>
  );
}

function EdgeHandle({
  position,
  type
}: {
  position: Position;
  type: 'source' | 'target';
}) {
  return (
    <Handle
      className="pointer-events-none !size-px !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0"
      isConnectable={false}
      position={position}
      type={type}
    />
  );
}

function statusIcon(status: RoadmapIssueAvailability) {
  if (status === 'ready' || status === 'closed') return CircleCheck;
  if (status === 'blocked' || status === 'cyclic') return AlertTriangle;
  if (status === 'inaccessible') return LockKeyhole;
  if (status === 'missing') return CircleX;
  return CircleDashed;
}
