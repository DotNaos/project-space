import type { ReactNode } from 'react';

export function PrototypeReviewDockAction({
  annotationCount = 0,
  children,
  className,
  isDark,
  label,
  onClick
}: {
  annotationCount?: number;
  children: ReactNode;
  className?: string;
  isDark: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      aria-label={label}
      className={`pointer-events-auto relative grid size-12 shrink-0 place-items-center rounded-full shadow-[0_14px_42px_rgba(0,0,0,0.28)] backdrop-blur-xl transition-colors max-[640px]:size-11 ${
        annotationCount
          ? 'bg-amber-400 text-neutral-950 hover:bg-amber-300'
          : isDark
            ? 'bg-neutral-900/95 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
            : 'bg-stone-100/95 text-neutral-500 hover:bg-white hover:text-neutral-900'
      } ${className ?? ''}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      {annotationCount ? (
        <span className="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-neutral-950 text-[9px] font-semibold text-white">
          {Math.min(annotationCount, 99)}
        </span>
      ) : null}
    </button>
  );
}
