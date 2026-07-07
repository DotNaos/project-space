import type { MouseEvent } from 'react';
import { cn } from '@/lib/utils';

export function PaneResizeHandle({
  axis,
  className,
  onStart
}: {
  axis: 'x' | 'y';
  className?: string;
  onStart(event: MouseEvent): void;
}) {
  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onMouseDown={onStart}
      className={cn(
        'absolute z-10 transition-colors hover:bg-neutral-600/60 active:bg-neutral-500/70',
        axis === 'x' ? 'inset-y-0 right-0 w-1 cursor-col-resize' : 'inset-x-0 top-0 h-1 cursor-row-resize',
        className
      )}
    />
  );
}
