import { createPortal } from 'react-dom';
import { GripVertical } from 'lucide-react';

import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { RoadmapIssueNode, RoadmapResult } from '@/shared/roadmap-api';
import type { RoadmapGeometricDropTarget } from './roadmap-drop-geometry';
import { roadmapMovePositionLabel } from './roadmap-work-shelf-model';

export interface RoadmapReorderDragState {
  active: boolean;
  graphRevision: string;
  issue: RoadmapIssueNode;
  offsetX: number;
  offsetY: number;
  originX: number;
  originY: number;
  overBacklog: boolean;
  overGraph: boolean;
  planRevision: number;
  target?: RoadmapGeometricDropTarget;
  width: number;
  x: number;
  y: number;
}

export function RoadmapDragOverlay({
  backlogElement,
  drag,
  orderingResult
}: {
  backlogElement?: HTMLElement | null;
  drag: RoadmapReorderDragState | null;
  orderingResult: RoadmapResult;
}) {
  if (!drag) return null;
  return <>
    {backlogElement ? createPortal(
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-0 z-50 grid place-items-center rounded-2xl border-2 border-dashed bg-neutral-950/25 text-sm font-semibold shadow-xl backdrop-blur-[1px] transition',
          drag.overBacklog
            ? 'border-sky-300 bg-sky-500/20 text-sky-50 shadow-sky-950/60'
            : 'border-neutral-600/70 text-neutral-200 shadow-black/30'
        )}
      >
        <span className="rounded-full border border-current/30 bg-neutral-950/80 px-4 py-2">
          Return #{drag.issue.issue.number} to unplanned work
        </span>
      </div>,
      backlogElement
    ) : null}
    {createPortal(
      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-[100]"
        style={{
          transform: `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px) rotate(${drag.overBacklog ? 1 : -1}deg)`,
          width: drag.width
        }}
      >
        <div className={cn(
          'rounded-xl border bg-neutral-950/95 p-3 shadow-2xl shadow-black/70 ring-1',
          drag.overBacklog
            ? 'border-sky-300/70 ring-sky-300/30'
            : 'border-emerald-400/60 ring-emerald-400/20'
        )}>
          <div className="flex items-center gap-2">
            <GripVertical className={cn('size-4', drag.overBacklog ? 'text-sky-200' : 'text-emerald-300')} />
            <Text className="font-mono text-[11px] text-neutral-400">#{drag.issue.issue.number}</Text>
            <Text className={cn('ml-auto text-[10px]', drag.overBacklog ? 'text-sky-200' : 'text-emerald-300')}>
              {drag.overBacklog
                ? 'Unplanned work'
                : drag.target === undefined
                ? 'Move in canvas'
                : roadmapMovePositionLabel(orderingResult, drag.issue.issue, drag.target.insertionIndex)}
            </Text>
          </div>
          <Text className="mt-1 line-clamp-2 text-sm font-medium text-neutral-100">{drag.issue.title}</Text>
        </div>
      </div>,
      document.body
    )}
  </>;
}
